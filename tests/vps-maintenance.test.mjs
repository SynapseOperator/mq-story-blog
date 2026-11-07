import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import https from "node:https";
import { runVpsMaintenance } from "../scripts/production/vps-maintenance.mjs";
import { validateDeploymentConfig } from "../scripts/production/database-config.mjs";

const id = "12345678-1234-4234-8234-123456789abc";

// Orchestration tests only. Real PostgreSQL/HTTPS/Restic acceptance remains a
// separate required run; these fakes verify containment and recovery boundaries.
async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), "mq-p501-maintenance-unit-"));
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "mq-p501-maintenance-unit-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  t.mock.method(fs, "statfs", async () => ({ bavail: 16 * 1024 ** 3, bsize: 1 }));
  syncBuiltinESMExports();
  await fs.writeFile(join(directory, "local-ca.pem"), "synthetic CA used only by mocked HTTPS");
  const manifest = { version: 1, environment: "staging", deploymentId: id,
    database: { host: "postgres", port: 5432, name: `mq_staging_${id.replaceAll("-", "")}` },
    origin: "https://mq.localhost:18443", media: { root: "/var/lib/mq/media", minFreeBytes: 512 * 1024 ** 2 } };
  const calls = [], volumes = [], state = { phase: "healthy" };
  const ctx = { directory, manifest, config: validateDeploymentConfig(manifest), state,
    project: `mq-p501-${id.replaceAll("-", "")}`, composeBase: ["compose", "--project-name", `mq-p501-${id.replaceAll("-", "")}`],
    images: { tools: "sha256:" + "1".repeat(64), operations: "sha256:" + "2".repeat(64) },
    volumeNames: { manifest: "fixture-manifest", "app-secrets": "fixture-app-secrets" },
    files: { auth_proxy_secret: "synthetic-proxy" }, passwords: { backup: "synthetic-backup" },
    bootstrapUrl: `postgresql://mq_bootstrap:synthetic-bootstrap@postgres:5432/${manifest.database.name}`,
    sourceSha: "a".repeat(40),
    save: async () => fs.writeFile(join(directory, "test-state.json"), JSON.stringify(state)),
    compose: (args) => { calls.push(args); return { status: 0, stdout: "", stderr: "" }; },
    docker: (args) => { calls.push(args); return { status: 0, stdout: "{}\n", stderr: "" }; },
    volume: async (name) => { volumes.push(name); const value = `${ctx.project}_${name}`; ctx.volumeNames[name] = value; return value; },
  };
  return { ctx, calls, volumes };
}

test("production, arbitrary project and unknown maintenance actions are rejected before Docker", async () => {
  for (const change of [{ manifest: { environment: "production" } }, { project: "mq-production" }, {}]) {
    let called = false;
    const ctx = { manifest: { environment: "staging" }, project: `mq-p501-${"a".repeat(32)}`,
      compose: () => { called = true; }, docker: () => { called = true; }, ...change };
    await assert.rejects(runVpsMaintenance(ctx, Object.keys(change).length ? "faults" : "drop-database"));
    assert.equal(called, false);
  }
});

test("less than 8 GiB refuses maintenance before any volume or container change", async t => {
  const { ctx, calls, volumes } = await fixture(t);
  fs.statfs = async () => ({ bavail: 8 * 1024 ** 3 - 1, bsize: 1 }); syncBuiltinESMExports();
  await assert.rejects(runVpsMaintenance(ctx, "restore"), /VPS_DISK_RESERVE_REQUIRED/);
  assert.deepEqual(calls, []); assert.deepEqual(volumes, []);
});

test("a failed fault action closes app and proxy without disclosing the underlying error", async t => {
  const { ctx, calls } = await fixture(t);
  ctx.compose = args => {
    calls.push(args);
    if (args[0] === "kill") throw new Error("private database diagnostic must not escape");
    return { status: 0 };
  };
  await assert.rejects(runVpsMaintenance(ctx, "faults"), { message: "VPS_ACCEPTANCE_FAILED_ENTRANCE_CLOSED" });
  assert.deepEqual(calls.at(-1), ["stop", "proxy", "app"]);
  assert.equal(calls.some(args => args.includes("down") || args.includes("prune")), false);
});

test("a failed stop is reported as unconfirmed containment", async t => {
  const { ctx } = await fixture(t);
  ctx.compose = args => { if (args[0] === "kill") throw new Error("operation failed"); return { status: 1 }; };
  await assert.rejects(runVpsMaintenance(ctx, "faults"), { message: "VPS_ACCEPTANCE_FAILED_CONTAINMENT_UNCONFIRMED" });
});

test("interrupted restore cannot overwrite its backup password or retry against the source", async t => {
  const { ctx, volumes } = await fixture(t);
  ctx.volume = async name => { volumes.push(name); throw new Error("simulated copy interruption"); };
  await assert.rejects(runVpsMaintenance(ctx, "restore"), /VPS_ACCEPTANCE_FAILED_ENTRANCE_CLOSED/);
  const count = volumes.length;
  await assert.rejects(runVpsMaintenance(ctx, "restore"), /VPS_ACCEPTANCE_PHASE_REJECTED/);
  await assert.rejects(runVpsMaintenance(ctx, "faults"), /VPS_ACCEPTANCE_PHASE_REJECTED/);
  assert.equal(volumes.length, count);
  // Even a stale healthy state cannot bypass the exclusive attempt marker.
  ctx.state.phase = "healthy";
  await assert.rejects(runVpsMaintenance(ctx, "restore"), { code: "EEXIST" });
  assert.equal(volumes.length, count);
});

test("restore permission verification failure never starts a restored application", async t => {
  const { ctx, calls } = await fixture(t);
  let backupCalls = 0, restoreCalls = 0;
  ctx.docker = args => {
    calls.push(args);
    const action = args.at(-1);
    if (action === "assert-restored") throw new Error("runtime permission audit failed");
    if (action === "backup") return { status: ++backupCalls === 1 ? 0 : 1, stdout: JSON.stringify({ snapshotId: "b".repeat(64) }) };
    if (action === "restore") return { status: ++restoreCalls === 1 ? 0 : 1, stdout: "{}" };
    if (action === "receipt") return { status: 0, stdout: JSON.stringify({ verified: true, deploymentId: id }) };
    return { status: 0, stdout: "{}" };
  };
  await assert.rejects(runVpsMaintenance(ctx, "restore"), /VPS_ACCEPTANCE_FAILED_ENTRANCE_CLOSED/);
  assert.equal(calls.some(args => args.includes("up")), false);
  assert.deepEqual(calls.at(-1), ["stop", "proxy", "app"]);
  await assert.rejects(fs.access(join(ctx.directory, "restore-receipt.json")), { code: "ENOENT" });
});

test("successful restore records a distinct target and disables publication before serving", async t => {
  const { ctx, calls } = await fixture(t);
  let backupCalls = 0, restoreCalls = 0;
  ctx.docker = args => {
    calls.push(args);
    const action = args.at(-1);
    if (action === "backup") return { status: ++backupCalls === 1 ? 0 : 1, stdout: JSON.stringify({ snapshotId: "b".repeat(64) }) };
    if (action === "restore") return { status: ++restoreCalls === 1 ? 0 : 1, stdout: "{}" };
    if (action === "receipt") return { status: 0, stdout: JSON.stringify({ verified: true, deploymentId: id }) };
    return { status: 0, stdout: "{}" };
  };
  t.mock.method(https, "get", (_url, options, callback) => {
    assert.equal(options.servername, "mq.localhost");
    assert.equal(options.rejectUnauthorized, undefined); // Node's secure default remains in force.
    const request = new EventEmitter(); request.destroy = error => request.emit("error", error);
    Promise.resolve().then(() => {
      const response = new EventEmitter(); response.statusCode = 200; response.resume = () => {};
      callback(response); response.emit("end");
    });
    return request;
  });
  const result = await runVpsMaintenance(ctx, "restore");
  assert.equal(result.productionDeployed, false);
  assert.notEqual(result.restoredDeploymentId, id);
  assert.notEqual(result.restoredDatabase, ctx.manifest.database.name);
  assert.equal(ctx.state.phase, "restored");
  const override = await fs.readFile(result.override, "utf8");
  assert.match(override, /MQ_PUBLISH_ENABLED: "false"/);
  assert.match(override, /MQ_COMMENTS_ENABLED: "false"/);
  assert.ok(calls.findIndex(args => args.at(-1) === "assert-restored") < calls.findIndex(args => args.includes("up")));
  const receipt = await fs.readFile(join(ctx.directory, "restore-receipt.json"), "utf8");
  assert.ok(!/synthetic-backup|synthetic-bootstrap|synthetic-proxy/.test(receipt));
  const count = calls.length;
  await assert.rejects(runVpsMaintenance(ctx, "faults"), /VPS_ACCEPTANCE_PHASE_REJECTED/);
  assert.equal(calls.length, count);
});
