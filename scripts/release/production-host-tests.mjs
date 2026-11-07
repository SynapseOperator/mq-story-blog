import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS } from "./bundle.mjs";
import { applyProductionHost, assertProductionCompose, readProductionReceipt, validateCurrentReleaseGate,
  validateHostSettings } from "./production-host.mjs";
import { planProductionBootstrap, planProductionChange, planProductionActivation } from "./production-plan.mjs";
import { claimProductionOperation, confirmInterruptedBackup } from "../production/operation-lock.mjs";
import { backupWindowFixture } from "../../tests/production-backup-window.test.mjs";
import { runBackupWindow } from "../production/backup-window.mjs";

const digest = "c".repeat(64), sourceSha = "a".repeat(40);
const disabled = { auth: false, media: false, publishing: false, comments: false };
const inspectSpace = async () => ({ bavail: 32 * 1024 ** 3, bsize: 1, files: 1000, ffree: 900 });

function fixture() {
  const config = { version: 1, deploymentId: randomUUID(), environment: "production",
    database: { host: "postgres", port: 5432, name: "mq_production" }, origin: "https://synthetic.example.invalid",
    media: { root: "/var/lib/mq/media", minFreeBytes: 8 * 1024 ** 3 } };
  const release = { version: 1, sourceSha, platform: "linux/amd64", gate: { kind: "reviewed-main", sourceSha },
    compatibility: { migrations: Array.from({ length: 8 }, (_, index) => ({ name: `migration_00${index + 1}`, sha256: digest })), contracts: {} },
    images: Object.fromEntries(TARGETS.map(name => [name, { file: `${name}.oci.tar`, archiveBytes: 1024, indexDigest: `sha256:${digest}` }])) };
  return { config, release, candidateManifestSha256: digest };
}

function composeSpec(config, images, openIngress = false) {
  const spec = { name: "mq-production", networks: { frontend: { internal: true }, database: { internal: true } }, services: {
    ...Object.fromEntries(["app", "tools", "proxy"].map(name => [name, { image: images[name], user: "10001:10001", read_only: true, environment: {} }])),
    postgres: { image: `postgres:18.6-bookworm@sha256:${digest}`, mem_limit: 768 * 1024 ** 2, volumes: [{ target: "/var/lib/postgresql" }] } } };
  Object.assign(spec.services.app, { mem_limit: 1536 * 1024 ** 2, environment: { MQ_DEPLOYMENT_ENV: "production", AUTH_ORIGIN: config.origin } });
  spec.services.proxy.environment.MQ_TLS_MODE = "public";
  if (openIngress) spec.services.proxy.ports = [{ published: "80", target: 80 }, { published: "443", target: 443 }];
  return spec;
}

async function testDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "mq-production-host-")); await chmod(root, 0o700);
  t.after(async () => { await rm(root, { recursive: true }); });
  return root;
}

async function hostFixture(t, action = "bootstrap") {
  const root = await testDirectory(t), input = fixture(), directory = join(root, "target");
  const bootstrap = planProductionBootstrap(input);
  const priorReceipt = { version: 1, verified: true, planId: bootstrap.planId, deploymentId: input.config.deploymentId,
    sourceSha, candidateManifestSha256: digest, release: input.release, completedAt: new Date().toISOString(),
    action: "bootstrap", features: disabled, publicIngress: false };
  const plan = action === "bootstrap" ? bootstrap : action === "activate"
    ? planProductionActivation({ currentRelease: input.release, config: input.config, receipt: priorReceipt })
    : planProductionChange({ ...input, currentRelease: input.release, mode: action,
      backupReceipt: { verified: true, deploymentId: input.config.deploymentId, snapshotId: digest, completedAt: new Date().toISOString() } });
  const approvalFile = join(root, "approval.json"), now = Date.now();
  await writeFile(approvalFile, JSON.stringify({ version: 1, planId: plan.planId, action: plan.action,
    sourceSha, deploymentId: plan.deploymentId, approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() }), { mode: 0o400 });
  if (action !== "bootstrap") {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "target.json"), JSON.stringify({ version: 1, deploymentId: input.config.deploymentId, project: "mq-production" }), { mode: 0o600 });
    await writeFile(join(directory, "receipt.json"), JSON.stringify(priorReceipt), { mode: 0o600 });
  }
  const commands = [], runDocker = args => {
    commands.push(args);
    if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64", DockerRootDir: root }) };
    if (args.includes("audit")) throw new Error("synthetic audit failure must stay private");
    return { stdout: "" };
  };
  return { root, directory, commands, runDocker, context: { ...input, plan, priorReceipt: action === "bootstrap" ? undefined : priorReceipt,
    settings: { approvalFile, targetDirectory: directory, candidateDirectory: root, secretDirectory: root,
      deploymentFile: join(root, "deployment.json"), candidateManifestSha256: digest } },
  confirmation: `${plan.action}:${plan.deploymentId}:${plan.planId}` };
}

test("host contract rejects dotenv interpolation, wrong production target and inline fields", () => {
  const { config } = fixture();
  const settings = { version: 1, targetDirectory: `/srv/mq-production/${config.deploymentId}`,
    approvalFile: "/root/mq/approval.json", candidateDirectory: "/root/mq/candidate", candidateManifestSha256: digest,
    deploymentFile: "/root/mq/deployment.json", gateFile: "/root/mq/gate.json", secretDirectory: "/root/mq/secrets", features: disabled };
  assert.equal(validateHostSettings(settings, config), settings);
  for (const changes of [{ targetDirectory: "/srv/existing" }, { secretDirectory: "/root/$TOKEN" },
    { candidateDirectory: "/root/mq/../other" }, { databasePassword: "never-accepted" }, { gateFile: null }])
    assert.throws(() => validateHostSettings({ ...settings, ...changes }, config));
});

test("fresh workstation review evidence must match the candidate and expires after one hour", () => {
  const now = Date.now(), gate = { kind: "reviewed-main", repository: "SynapseOperator/mq-story-blog", sourceSha,
    observedMainSha: sourceSha, reviewedHead: "b".repeat(40), reviewer: "SnorkelingBreather", pullRequest: 59,
    reviewId: 123, qualityRunId: 456, checkedAt: new Date(now).toISOString() };
  validateCurrentReleaseGate(gate, sourceSha, now);
  for (const changes of [{ sourceSha: "b".repeat(40) }, { reviewer: "owner" }, { qualityRunId: 0 },
    { checkedAt: new Date(now + 1).toISOString() }, { checkedAt: new Date(now - 3600001).toISOString() }])
    assert.throws(() => validateCurrentReleaseGate({ ...gate, ...changes }, sourceSha, now));
});

test("compose validation keeps private ports closed and requires explicit separate ingress activation", () => {
  const { config, release } = fixture(), images = Object.fromEntries(TARGETS.map(name => [name, release.images[name].indexDigest]));
  const spec = composeSpec(config, images);
  assertProductionCompose(spec, { images, config });
  spec.services.proxy.ports = [{ published: "80", target: 80 }, { published: "443", target: 443 }];
  assert.throws(() => assertProductionCompose(spec, { images, config }));
  assertProductionCompose(spec, { images, config, openIngress: true });
  spec.services.postgres.ports = [{ published: "5432", target: 5432 }];
  assert.throws(() => assertProductionCompose(spec, { images, config, openIngress: true }));
});

test("private receipts admit complete OCI metadata above 4 KiB but reject excess size and hard links", async t => {
  const root = await testDirectory(t), file = join(root, "receipt.json"), value = { metadata: "a".repeat(8192) };
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  assert.deepEqual(await readProductionReceipt(file), value);
  await link(file, join(root, "linked.json"));
  await assert.rejects(readProductionReceipt(file));
  const oversized = join(root, "oversized.json");
  await writeFile(oversized, "a".repeat(65537), { mode: 0o600 });
  await assert.rejects(readProductionReceipt(oversized));
});

test("concurrent production release and backup have one owner; completed claims preserve an audit record", async t => {
  const root = await testDirectory(t), deploymentId = randomUUID();
  const results = await Promise.allSettled(["release", "backup"].map(kind => claimProductionOperation({ deploymentId,
    kind, operationId: randomUUID() }, { directory: root })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const claim = results.find(result => result.status === "fulfilled").value;
  await claim.assertOwned(); await claim.complete();
  assert.equal((await readdir(root)).filter(name => name.startsWith("operation-")).length, 1);
  const next = await claimProductionOperation({ deploymentId, kind: "release", operationId: randomUUID() }, { directory: root });
  await assert.rejects(claim.assertOwned()); await next.assertOwned();
  await assert.rejects(confirmInterruptedBackup(deploymentId, { directory: root }));
});

test("backup failure cleanup cannot borrow a live backup or release claim", async t => {
  for (const kind of ["release", "backup"]) {
    const root = await testDirectory(t), deploymentId = randomUUID();
    await claimProductionOperation({ deploymentId, kind, operationId: randomUUID() }, { directory: root });
    await assert.rejects(confirmInterruptedBackup(deploymentId, { directory: root }));
  }
});

test("host lock contention never stops the winning release or backup", async t => {
  for (const action of ["bootstrap", "upgrade"]) {
    const f = await hostFixture(t, action);
    await assert.rejects(applyProductionHost(f.context, f.confirmation, { runDocker: f.runDocker, inspectSpace,
      claimOperation: async () => { throw new Error("busy"); } }), { message: "PRODUCTION_FAILED_CONTAINMENT_UNCONFIRMED" });
    assert.ok(!f.commands.some(args => args.includes("stop") || args.includes("load")));
  }
});

test("a bootstrap target created after preflight is preserved and never stopped by containment", async t => {
  const f = await hostFixture(t);
  await assert.rejects(applyProductionHost(f.context, f.confirmation, { runDocker: f.runDocker, inspectSpace,
    claimOperation: async value => { await mkdir(f.directory, { mode: 0o700 });
      await writeFile(join(f.directory, "foreign-marker"), "preserve"); return claimProductionOperation(value, { directory: f.root }); } }),
  { message: "PRODUCTION_FAILED_CONTAINMENT_UNCONFIRMED" });
  assert.equal(await readFile(join(f.directory, "foreign-marker"), "utf8"), "preserve");
  assert.ok(!f.commands.some(args => args.includes("stop")));
});

test("activation audit failure is read-only and never claims, rewrites configuration or stops services", async t => {
  const f = await hostFixture(t, "activate"), before = await readdir(f.directory);
  await assert.rejects(applyProductionHost(f.context, f.confirmation, { runDocker: f.runDocker, inspectSpace,
    claimOperation: async () => { assert.fail("Read-only audit must precede the operation claim"); } }),
  { message: "PRODUCTION_VALIDATION_FAILED_NO_CHANGES" });
  assert.deepEqual(await readdir(f.directory), before);
  assert.ok(f.commands.some(args => args.includes("audit")));
  assert.ok(!f.commands.some(args => args.includes("stop") || args.includes("up")));
});

test("a closed receipt with an unexpectedly running proxy fails before any mutation", async t => {
  const f = await hostFixture(t, "activate");
  const runDocker = args => {
    if (args.includes("ps") && args.at(-1) === "proxy") return { stdout: "e".repeat(64) };
    if (args[0] === "inspect") return { stdout: JSON.stringify([{ Config: { Labels: {
      "com.docker.compose.project": "mq-production", "com.docker.compose.service": "proxy" } }, State: { Running: true } }]) };
    return f.runDocker(args);
  };
  await assert.rejects(applyProductionHost(f.context, f.confirmation, { runDocker, inspectSpace,
    claimOperation: async () => { assert.fail("Contradictory target must not be claimed"); } }),
  { message: "PRODUCTION_PREFLIGHT_FAILED_NO_CHANGES" });
  assert.ok(!f.commands.some(args => args.includes("stop") || args.includes("audit")));
});

test("bootstrap, separate activation and upgrade retain distinct receipts without overwriting prior evidence", async t => {
  const f = await hostFixture(t), images = Object.fromEntries(TARGETS.map(name => [name, `sha256:${digest}`]));
  f.context.settings.deploymentFile = "/root/mq/deployment.json";
  f.context.settings.secretDirectory = "/root/mq/secrets";
  // Real control-file I/O and exclusive lock. Docker/probe are command doubles;
  // this tests orchestration, not a claim that real containers were deployed.
  const runDocker = args => {
    f.commands.push(args);
    if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64", DockerRootDir: f.root }) };
    if (args[0] === "image" && args[1] === "inspect") return { stdout: JSON.stringify({ digest: `sha256:${digest}` }) };
    if (args.includes("config")) {
      const proxyStarts = f.commands.filter(command => command.includes("up") && command.at(-1) === "proxy").length;
      const configChecks = f.commands.filter(command => command.includes("config")).length;
      return { stdout: JSON.stringify(composeSpec(f.context.config, images, configChecks === 3 && proxyStarts === 0)) };
    }
    return { stdout: "" };
  };
  const options = { runDocker, inspectSpace, probeHttps: async () => true,
    claimOperation: value => claimProductionOperation(value, { directory: f.root }) };
  const result = await applyProductionHost(f.context, f.confirmation, options);
  assert.equal(result.receipt.publicIngress, false);
  assert.ok(!f.commands.some(args => args.includes("up") && args.at(-1) === "proxy"));
  let priorReceipt = result.receipt;
  for (const action of ["activate", "upgrade"]) {
    const plan = action === "activate" ? planProductionActivation({ currentRelease: f.context.release,
      config: f.context.config, receipt: priorReceipt, features: { ...disabled, auth: true } })
      : planProductionChange({ release: f.context.release, currentRelease: f.context.release,
        config: f.context.config, candidateManifestSha256: digest, mode: "upgrade",
        backupReceipt: { verified: true, deploymentId: f.context.config.deploymentId, snapshotId: digest, completedAt: new Date().toISOString() } });
    const now = Date.now();
    await chmod(f.context.settings.approvalFile, 0o600);
    await writeFile(f.context.settings.approvalFile, JSON.stringify({ version: 1, planId: plan.planId, action,
      sourceSha, deploymentId: plan.deploymentId, approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() }));
    await chmod(f.context.settings.approvalFile, 0o400);
    const next = await applyProductionHost({ ...f.context, plan, priorReceipt }, `${action}:${plan.deploymentId}:${plan.planId}`, options);
    assert.equal(next.receipt.publicIngress, action === "activate");
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, `receipt-${priorReceipt.planId}.json`))), priorReceipt);
    priorReceipt = next.receipt;
  }
  assert.equal((await readdir(f.directory)).filter(name => name.startsWith("operation-")).length, 3);
});

test("a scheduled production backup cannot stop services while a release owns the host", async t => {
  const f = await backupWindowFixture(t), directory = f.raw.releaseDirectory;
  f.config.project = "mq-production"; f.config.deployment.environment = "production";
  f.spec.name = "mq-production"; f.spec.services.tools.environment.MQ_DEPLOYMENT_ENV = "production";
  f.containers.forEach(container => { container.Config.Labels["com.docker.compose.project"] = "mq-production"; });
  await claimProductionOperation({ deploymentId: f.config.deploymentId, kind: "release", operationId: randomUUID() }, { directory });
  await assert.rejects(runBackupWindow(f.config, { run: f.run,
    claimOperation: value => claimProductionOperation(value, { directory }) }), error => !error.manualRecoveryRequired);
  assert.deepEqual(f.events, []);
  await assert.rejects(runBackupWindow(f.config, { run: f.run, closeOnly: true,
    confirmInterrupted: id => confirmInterruptedBackup(id, { directory }) }), error => !error.manualRecoveryRequired);
  assert.deepEqual(f.events, [], "systemd failure handler must not borrow a release's lock");
});

test("production backup releases the shared claim only after its verified backup and restart", async t => {
  const f = await backupWindowFixture(t), directory = f.raw.releaseDirectory;
  f.config.project = "mq-production"; f.config.deployment.environment = "production";
  f.spec.name = "mq-production"; f.spec.services.tools.environment.MQ_DEPLOYMENT_ENV = "production";
  f.containers.forEach(container => { container.Config.Labels["com.docker.compose.project"] = "mq-production"; });
  await runBackupWindow(f.config, { run: f.run, claimOperation: value => claimProductionOperation(value, { directory }) });
  assert.deepEqual(f.events, ["stop", "pause", "backup", "resume", "start"]);
  await claimProductionOperation({ deploymentId: f.config.deploymentId, kind: "release", operationId: randomUUID() }, { directory });
});
