import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import https from "node:https";
import { promisify } from "node:util";
import { runVpsMaintenance, waitForHttpsReady } from "../scripts/production/vps-maintenance.mjs";
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
  const output = [];
  t.mock.method(console, "error", value => output.push(value));
  ctx.compose = args => {
    calls.push(args);
    if (args[0] === "kill") throw Object.assign(new Error("private database diagnostic must not escape"), {
      code: "private-cookie-must-not-escape", stdout: "synthetic-password", stack: "private stack",
    });
    return { status: 0 };
  };
  await assert.rejects(runVpsMaintenance(ctx, "faults"), { message: "VPS_ACCEPTANCE_FAILED_ENTRANCE_CLOSED" });
  assert.deepEqual(calls.at(-1), ["stop", "proxy", "app"]);
  assert.equal(calls.some(args => args.includes("down") || args.includes("prune")), false);
  const names = (await fs.readdir(ctx.directory)).filter(name => /^faults-failure-[a-f0-9-]+\.json$/.test(name));
  assert.equal(names.length, 1);
  const text = await fs.readFile(join(ctx.directory, names[0]), "utf8");
  assert.deepEqual(JSON.parse(text), { action: "faults", stage: "crash-kill", containment: "closed" });
  assert.equal(output[0], `VPS_MAINTENANCE_FAILURE=${text}`);
  assert.ok(!/private|synthetic-password/.test(text + output.join("")));
});

test("an unexpected HTTPS status immediately closes ingress and records its real status", async t => {
  const { ctx, calls } = await fixture(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(https, "get", (_url, _options, callback) => {
    const request = new EventEmitter(); request.destroy = error => request.emit("error", error);
    Promise.resolve().then(() => {
      const response = new EventEmitter(); response.statusCode = 500; response.resume = () => {};
      callback(response); response.emit("end");
    });
    return request;
  });
  await assert.rejects(runVpsMaintenance(ctx, "faults"), /VPS_ACCEPTANCE_FAILED_ENTRANCE_CLOSED/);
  const name = (await fs.readdir(ctx.directory)).find(value => value.startsWith("faults-failure-"));
  assert.deepEqual(JSON.parse(await fs.readFile(join(ctx.directory, name), "utf8")), {
    action: "faults", stage: "crash-https", containment: "closed", httpStatus: 500, errorCode: "ERR_ASSERTION",
    readiness: [{ attempt: 1, httpStatus: 500 }],
  });
  assert.deepEqual(calls.at(-1), ["stop", "proxy", "app"]);
  assert.equal(calls.some(args => args[0] === "stop" && args[1] === "postgres"), false);
});

test("real HTTPS readiness waits for a delayed listener but rejects lasting errors and untrusted TLS", async t => {
  const { ctx } = await fixture(t);
  const executable = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl";
  await promisify(execFile)(executable, ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(ctx.directory, "test-private.pem"), "-out", join(ctx.directory, "test-ca.pem"),
    "-days", "1", "-subj", "/CN=mq.localhost", "-addext", "subjectAltName=DNS:mq.localhost"],
  { windowsHide: true, timeout: 30000 });
  const key = await fs.readFile(join(ctx.directory, "test-private.pem"));
  const ca = await fs.readFile(join(ctx.directory, "test-ca.pem"));
  let mode = "warming", responses = 0;
  const seen = [];
  const server = https.createServer({ key, cert: ca }, (request, response) => {
    seen.push({ host: request.headers.host, servername: request.socket.servername, path: request.url });
    const status = mode === "warming" ? [502, 503, 200][Math.min(responses, 2)] : Number(mode);
    responses++; response.writeHead(status); response.end("synthetic response body is never logged");
  });
  const listen = port => new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
  try {
    await listen(0);
    const port = server.address().port;
    await new Promise(done => server.close(done));
    const origin = `https://mq.localhost:${port}`, observations = [];
    let opening;
    const options = { maxAttempts: 20, totalMs: 3000, intervalMs: 10, requestTimeoutMs: 500 };
    assert.equal(await waitForHttpsReady(origin, ca, { ...options, onFailure: value => {
      observations.push(value);
      if (value.errorCode === "ECONNREFUSED" && !opening) opening = listen(port);
    } }), 200);
    await opening;
    assert.equal(observations[0].errorCode, "ECONNREFUSED");
    assert.deepEqual(observations.filter(value => value.httpStatus).map(value => value.httpStatus), [502, 503]);
    assert.ok(seen.every(value => value.host === `mq.localhost:${port}` && value.servername === "mq.localhost" && value.path === "/api/stories"));

    mode = "503"; responses = 0;
    const failed = [];
    await assert.rejects(waitForHttpsReady(origin, ca, { ...options, maxAttempts: 3, onFailure: value => failed.push(value) }), /VPS_HTTPS_NOT_READY/);
    assert.equal(responses, 3);
    assert.deepEqual(failed, [1, 2, 3].map(attempt => ({ attempt, httpStatus: 503 })));

    const untrusted = [];
    await assert.rejects(waitForHttpsReady(origin, undefined, { ...options, onFailure: value => untrusted.push(value) }), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    assert.deepEqual(untrusted, [{ attempt: 1, errorCode: "DEPTH_ZERO_SELF_SIGNED_CERT" }]);
    assert.equal(responses, 3); // Failed TLS never reaches the HTTP handler.
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
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
  const failure = (await fs.readdir(ctx.directory)).find(name => name.startsWith("restore-failure-"));
  assert.equal(JSON.parse(await fs.readFile(join(ctx.directory, failure), "utf8")).stage, "restore-permission-audit");
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
