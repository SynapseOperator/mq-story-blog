import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBackupWindowConfiguration, runBackupWindow } from "../scripts/production/backup-window.mjs";

export async function backupWindowFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mq-backup-window-"));
  const deploymentId = randomUUID(), sourceRevision = "a".repeat(40), receiptDirectory = join(root, "status");
  await mkdir(receiptDirectory, { mode: 0o700 });
  const configFile = join(root, "window.json");
  const raw = { version: 1, deploymentId, project: "mq-staging", releaseDirectory: root,
    composeEnvironmentFile: join(root, "compose.env"), overrideFile: join(root, "backup.yaml"),
    deploymentFile: join(root, "deployment.json"), receiptDirectory };
  await writeFile(raw.composeEnvironmentFile, "MQ_DEPLOYMENT_ENV=staging", { mode: 0o600 });
  await writeFile(raw.overrideFile, "services: {}", { mode: 0o400 });
  await writeFile(raw.deploymentFile, JSON.stringify({ version: 1, deploymentId, environment: "staging",
    database: { host: "postgres", port: 5432, name: "mq_staging" }, origin: "https://synthetic.example.invalid",
    media: { root: join(root, "media"), minFreeBytes: 256 * 1024 * 1024 } }), { mode: 0o400 });
  await writeFile(configFile, JSON.stringify(raw), { mode: 0o400 });
  t.after(async () => {
    for (const file of [configFile, raw.overrideFile, raw.deploymentFile]) await chmod(file, 0o600);
    await rm(root, { recursive: true });
  });
  const config = await readBackupWindowConfiguration(configFile, `--confirm-deployment=${deploymentId}`);
  const image = `registry.example.invalid/mq@sha256:${"1".repeat(64)}`;
  const spec = { name: config.project, configs: { deployment: { file: config.deploymentFile } },
    services: { app: { image }, proxy: { image }, postgres: { image }, tools: { image, user: "10001:10001", read_only: true,
      environment: { MQ_DEPLOYMENT_CONFIG: "/etc/mq/deployment.json", MQ_DEPLOYMENT_ENV: "staging", MQ_BACKUP_SOURCE_REVISION: sourceRevision },
      configs: [{ source: "deployment", target: "/etc/mq/deployment.json" }],
      volumes: [{ type: "bind", source: receiptDirectory, target: "/var/lib/mq/backup-status" }] } } };
  const containers = ["app", "proxy", "postgres"].map(service => ({ Config: { Image: image,
    Labels: { "com.docker.compose.project": config.project, "com.docker.compose.service": service } },
    State: { Running: true, Health: { Status: "healthy" } } }));
  const events = []; let entryOpen = true, writersPaused = false, interrupted = false, failure;
  const run = async args => {
    if (args[0] === "inspect") return JSON.stringify(containers);
    if (args.includes("config")) return JSON.stringify(spec);
    if (args.includes("ps")) return ["a".repeat(64), "b".repeat(64), "c".repeat(64)].join("\n");
    const action = args.includes("stop") ? "stop" : args.includes("up") ? "start"
      : args.includes("pause") ? "pause" : args.includes("resume") ? "resume" : "backup";
    events.push(action);
    if (failure === action) throw new Error("synthetic failure details must not escape");
    if (action === "stop") entryOpen = false;
    if (action === "pause") writersPaused = true;
    if (action === "resume") writersPaused = false;
    if (action === "start") entryOpen = true;
    if (action === "backup") {
      assert.equal(writersPaused, true); assert.equal(entryOpen, false);
      const target = args.find(item => item.startsWith("MQ_BACKUP_RECEIPT="));
      const name = target.split("/").at(-1);
      const receipt = { verified: true, deploymentId, snapshotId: "a".repeat(64), sourceRevision,
        completedAt: new Date().toISOString(), backend: "local", assets: 1, files: 2 };
      await writeFile(join(receiptDirectory, name), JSON.stringify(receipt), { mode: 0o600 });
      return JSON.stringify(receipt);
    }
    return "{}";
  };
  return { config, configFile, raw, spec, containers, events, run, interrupt: () => { interrupted = true; },
    interrupted: () => interrupted, fail: value => { failure = value; }, state: () => ({ entryOpen, writersPaused }) };
}

test("backup window verifies the target and resumes only after a real receipt is read", async t => {
  const f = await backupWindowFixture(t);
  const result = await runBackupWindow(f.config, { run: f.run });
  assert.equal(result.completed, true); assert.equal(result.entryRestored, true);
  assert.deepEqual(f.events, ["stop", "pause", "backup", "resume", "start"]);
  assert.deepEqual(f.state(), { entryOpen: true, writersPaused: false });
  assert.equal(JSON.parse(await readFile(join(f.config.receiptDirectory, "latest.json"))).verified, true);
  await assert.rejects(access(join(f.config.receiptDirectory, "backup-window.lock")));
});

test("backup failure closes entry, keeps writers paused and blocks another scheduled run", async t => {
  const f = await backupWindowFixture(t); f.fail("backup");
  await assert.rejects(runBackupWindow(f.config, { run: f.run }), error => error.message === "BACKUP_WINDOW_FAILED"
    && error.closureConfirmed && error.manualRecoveryRequired);
  assert.deepEqual(f.events, ["stop", "pause", "backup", "stop", "pause"]);
  assert.deepEqual(f.state(), { entryOpen: false, writersPaused: true });
  await access(join(f.config.receiptDirectory, "backup-window.lock"));
  await assert.rejects(access(join(f.config.receiptDirectory, "latest.json")));
  assert.deepEqual(JSON.parse(await readFile(join(f.config.receiptDirectory, "backup-failure.json"))).failures, ["BACKUP_FAILED"]);
  f.events.length = 0;
  await assert.rejects(runBackupWindow(f.config, { run: f.run }));
  assert.deepEqual(f.events, [], "An operator must inspect and release the stale maintenance lock");
});

test("interruption after backup and restart failure never leave the application open", async t => {
  for (const scenario of ["interruption", "start"]) {
    const f = await backupWindowFixture(t);
    const run = async args => {
      const result = await f.run(args);
      if (scenario === "interruption" && args.includes("scripts/production/backup-cli.mjs")) f.interrupt();
      return result;
    };
    if (scenario === "start") f.fail("start");
    await assert.rejects(runBackupWindow(f.config, { run, interrupted: f.interrupted }), error => error.closureConfirmed === true);
    assert.deepEqual(f.state(), { entryOpen: false, writersPaused: true });
    if (scenario === "interruption") assert.equal(f.events.includes("resume"), false);
    assert.equal(JSON.parse(await readFile(join(f.config.receiptDirectory, "latest.json"))).verified, true,
      "Verified backup evidence remains valid even if application recovery needs operator action");
  }
});

test("wrong deployment confirmation, container labels or config mount refuse before stopping services", async t => {
  const f = await backupWindowFixture(t);
  await assert.rejects(readBackupWindowConfiguration(f.configFile, `--confirm-deployment=${randomUUID()}`),
    { message: "BACKUP_WINDOW_CONFIG_REJECTED" });
  f.containers[0].Config.Labels["com.docker.compose.project"] = "unrelated-project";
  await assert.rejects(runBackupWindow(f.config, { run: f.run }));
  assert.deepEqual(f.events, []);
  f.containers[0].Config.Labels["com.docker.compose.project"] = f.config.project;
  f.spec.services.tools.configs[0].target = "/wrong-file";
  await assert.rejects(runBackupWindow(f.config, { run: f.run }));
  assert.deepEqual(f.events, []);
});

test("a cross-environment backup prefix fails before stopping the app or claiming a production lock", async t => {
  for (const [environment, prefix] of [["production", "p502-synthetic/test"], ["staging", "production"]]) {
    const f = await backupWindowFixture(t);
    f.config.deployment.environment = environment;
    Object.assign(f.spec.services.tools.environment, { MQ_DEPLOYMENT_ENV: environment,
      MQ_BACKUP_BACKEND: "s3", MQ_BACKUP_REPOSITORY: `s3:https://oss-cn-hongkong.aliyuncs.com/mq-backups/${prefix}` });
    let claimed = false;
    await assert.rejects(runBackupWindow(f.config, { run: f.run, claimOperation: () => { claimed = true; } }),
      error => error.phase === "preflight" && error.manualRecoveryRequired === false);
    assert.equal(claimed, false);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.state(), { entryOpen: true, writersPaused: false });
  }
});

test("systemd failure cleanup can close an interrupted window without automatically resuming", async t => {
  const f = await backupWindowFixture(t);
  f.containers[0].State.Running = false;
  const result = await runBackupWindow(f.config, { run: f.run, closeOnly: true });
  assert.equal(result.closed, true);
  assert.deepEqual(f.events, ["stop", "pause"]);
  assert.deepEqual(f.state(), { entryOpen: false, writersPaused: true });
});
