import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import https from "node:https";
import { chmod, chown, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { TARGETS, sha256 } from "./bundle.mjs";
import { applyProductionHost, assertProductionCompose, readProductionReceipt, readSecrets, validateCurrentReleaseGate,
  validateHostSettings, readPrivatePreviewFiles, privateHttpsHealthy, assertPrivateDockerRouting, assertPrivateProxyNetworks } from "./production-host.mjs";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "../production/database-config.mjs";
import { planProductionBootstrap, planProductionChange, planProductionActivation,
  planProductionPrivatePreview, planProductionPreviewClose } from "./production-plan.mjs";
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
    compatibility: { migrations: Array.from({ length: 9 }, (_, index) => ({ name: `migration_00${index + 1}`, sha256: digest })), contracts: {} },
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

test("actual production secret files require a strong bootstrap password as well as role passwords", {
  skip: process.platform !== "linux" || process.geteuid?.() !== 0,
}, async t => {
  const root = await testDirectory(t), config = validateDeploymentConfig(fixture().config);
  const passwords = Object.fromEntries(LOGIN_IDENTITIES.map((name, index) => [name, String(index + 1).repeat(64)]));
  const url = (role, password) => `postgresql://${role}:${encodeURIComponent(password)}@postgres:5432/mq_production`;
  const files = {
    database_url: url(config.roles.runtime, passwords.runtime), migration_database_url: url(config.roles.migration, passwords.migration),
    role_passwords: JSON.stringify(passwords), auth_secret: "6".repeat(64), session_storage_key: "b".repeat(64), auth_proxy_secret: "7".repeat(64),
    publish_signing_key: "8".repeat(64), comment_signing_key: "9".repeat(64),
  };
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(root, name), value, { mode: 0o400 }); await chown(join(root, name), 10001, 10001);
  }
  const setBootstrap = async password => {
    for (const [name, value, uid] of [["postgres_password", password, 999],
      ["bootstrap_database_url", url("mq_bootstrap", password), 10001]]) {
      await writeFile(join(root, name), value, { mode: 0o400 }); await chown(join(root, name), uid, uid);
    }
  };
  for (const password of ["a".repeat(64), "_".repeat(32)]) { await setBootstrap(password); await readSecrets(root, config); }
  const storageFile = join(root, "session_storage_key");
  for (const value of ["short", files.auth_secret, files.auth_proxy_secret, files.publish_signing_key, files.comment_signing_key, passwords.runtime]) {
    await writeFile(storageFile, value);
    await assert.rejects(readSecrets(root, config));
  }
  await writeFile(storageFile, files.session_storage_key);
  await readSecrets(root, config);
  for (const password of ["short", "a".repeat(129), `${"a".repeat(31)}!`]) {
    await setBootstrap(password);
    await assert.rejects(readSecrets(root, config), /PRODUCTION_BOOTSTRAP_PASSWORD_REJECTED/);
  }
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

function privateMetadata(root = "/root/mq-preview") {
  return { version: 1, host: "127.0.0.1", port: 18443,
    ca: { path: posix.join(root, "ca.pem"), sha256: digest },
    certificate: { path: posix.join(root, "server.pem"), sha256: digest },
    privateKey: { path: posix.join(root, "server.key"), sha256: digest } };
}

function privateCompose(config, images, preview) {
  const spec = composeSpec(config, images);
  spec.services.proxy.environment.MQ_TLS_MODE = "private";
  spec.services.proxy.ports = [{ host_ip: "127.0.0.1", published: String(preview.port), target: 443, protocol: "tcp" }];
  spec.services.proxy.secrets = ["auth_proxy_secret", "preview_certificate", "preview_private_key"].map(name => ({ source: name, target: `/run/secrets/${name}` }));
  spec.secrets = { preview_certificate: { file: preview.certificate.path }, preview_private_key: { file: preview.privateKey.path } };
  return spec;
}

const previewNetworks = () => ["edge", "frontend"].map(name => ({ Name: `mq-production_${name}`, Driver: "bridge",
  EnableIPv6: false, Internal: name === "frontend", Labels: { "com.docker.compose.project": "mq-production" }, Options: {} }));

test("private ingress admits only exact IPv4 loopback TCP, approved cert mounts and normal NAT networks", () => {
  const { config, release } = fixture(), images = Object.fromEntries(TARGETS.map(name => [name, release.images[name].indexDigest]));
  const preview = privateMetadata(), good = privateCompose(config, images, preview);
  assertProductionCompose(good, { images, config, preview });
  for (const mutate of [value => { delete value.services.proxy.ports[0].host_ip; },
    value => { value.services.proxy.ports[0].host_ip = "0.0.0.0"; }, value => { value.services.proxy.ports[0].host_ip = "::1"; },
    value => { value.services.proxy.ports[0].published = "443"; }, value => { value.services.proxy.ports[0].protocol = "udp"; },
    value => { value.services.proxy.ports.push({ published: "80", target: 80 }); },
    value => { value.services.app.ports = [{ published: "3000", target: 3000 }]; },
    value => { value.services.proxy.network_mode = "host"; },
    value => { value.secrets.preview_private_key.file = "/other/key"; },
    value => { value.services.proxy.secrets.push({ source: "bootstrap_database_url", target: "bootstrap_database_url" }); },
  ]) { const changed = globalThis.structuredClone(good); mutate(changed); assert.throws(() => assertProductionCompose(changed, { images, config, preview })); }
  assertPrivateDockerRouting(["dockerd"], {});
  assertPrivateDockerRouting(["dockerd", "--iptables=true"], { iptables: true });
  for (const [args, config] of [[["dockerd"], { iptables: false }], [["dockerd", "--iptables=false"], {}],
    [["dockerd", "--iptables", "false"], {}]]) assert.throws(() => assertPrivateDockerRouting(args, config), /FIREWALL_REQUIRED/);
  assertPrivateDockerRouting(["dockerd", "--allow-direct-routing=false"], { "allow-direct-routing": false });
  for (const [args, config] of [[["dockerd", "--allow-direct-routing"], {}], [["dockerd", "--allow-direct-routing=true"], {}],
    [["dockerd"], { "allow-direct-routing": true }]]) assert.throws(() => assertPrivateDockerRouting(args, config));
  assertPrivateProxyNetworks(previewNetworks());
  for (const mutate of [value => { value[0].Driver = "macvlan"; }, value => { value[0].EnableIPv6 = true; },
    value => { value[0].Options["com.docker.network.bridge.gateway_mode_ipv4"] = "routed"; },
    value => { value[0].Options["com.docker.network.bridge.gateway_mode_ipv6"] = "nat-unprotected"; },
    value => { value[0].Options["com.docker.network.bridge.trusted_host_interfaces"] = "eth0"; }]) {
    const changed = previewNetworks(); mutate(changed); assert.throws(() => assertPrivateProxyNetworks(changed));
  }
});

test("private TLS files bind hashes, host, key, server usage, owner and actual verified HTTPS", {
  skip: process.platform !== "linux" || process.geteuid?.() !== 0,
}, async t => {
  const root = await testDirectory(t), preview = privateMetadata(root);
  const openssl = args => execFileSync("openssl", args, { stdio: "ignore" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "ca.key"),
    "-out", preview.ca.path, "-days", "1", "-subj", "/CN=MQ Synthetic Preview CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", preview.privateKey.path, "-out", join(root, "server.csr"), "-subj", "/CN=mq-story.xyz"]);
  await writeFile(join(root, "extensions"), "subjectAltName=DNS:mq-story.xyz\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n");
  openssl(["x509", "-req", "-in", join(root, "server.csr"), "-CA", preview.ca.path, "-CAkey", join(root, "ca.key"),
    "-CAcreateserial", "-out", preview.certificate.path, "-days", "1", "-extfile", join(root, "extensions")]);
  for (const name of ["ca", "certificate", "privateKey"]) {
    await chmod(preview[name].path, 0o400); await chown(preview[name].path, 10001, 10001);
    preview[name].sha256 = sha256(await readFile(preview[name].path));
  }
  const { ca } = await readPrivatePreviewFiles(preview, "https://mq-story.xyz");
  await assert.rejects(readPrivatePreviewFiles(preview, "https://wrong.example.org"), /HOSTNAME/);
  await assert.rejects(readPrivatePreviewFiles(preview, "https://mq-story.xyz", Date.now() + 3 * 86400000), /EXPIRED/);
  const mismatch = globalThis.structuredClone(preview); mismatch.privateKey.sha256 = "0".repeat(64);
  await assert.rejects(readPrivatePreviewFiles(mismatch, "https://mq-story.xyz"), /FILE_CHANGED/);
  await chmod(preview.privateKey.path, 0o644);
  await assert.rejects(readPrivatePreviewFiles(preview, "https://mq-story.xyz"), /FILE_REJECTED/);
  await chmod(preview.privateKey.path, 0o400);
  await chown(preview.privateKey.path, 0, 0);
  await assert.rejects(readPrivatePreviewFiles(preview, "https://mq-story.xyz"), /FILE_REJECTED/);
  await chown(preview.privateKey.path, 10001, 10001);
  let host;
  const server = https.createServer({ key: await readFile(preview.privateKey.path), cert: await readFile(preview.certificate.path) },
    (request, response) => { host = request.headers.host; response.end("ok"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  preview.port = server.address().port;
  assert.equal(await privateHttpsHealthy({ origin: "https://mq-story.xyz", preview, ca }, { attempts: 1, waitMs: 0 }), true);
  assert.equal(host, "mq-story.xyz");
  assert.equal(await privateHttpsHealthy({ origin: "https://wrong.example.org", preview, ca }, { attempts: 1, waitMs: 0 }), false);
  assert.equal(await privateHttpsHealthy({ origin: "https://mq-story.xyz", preview, ca: Buffer.from("untrusted") }, { attempts: 1, waitMs: 0 }), false);
  await assert.rejects(privateHttpsHealthy({ origin: "https://mq-story.xyz", preview }), /CA_REQUIRED/);
});

test("private preview host writes only loopback and closing revokes sessions before a disabled receipt", async t => {
  const f = await hostFixture(t, "activate"), images = Object.fromEntries(TARGETS.map(name => [name, `sha256:${digest}`]));
  f.context.settings.deploymentFile = "/root/mq/deployment.json"; f.context.settings.secretDirectory = "/root/mq/secrets";
  const preview = privateMetadata(), opened = planProductionPrivatePreview({ currentRelease: f.context.release,
    config: f.context.config, receipt: f.context.priorReceipt, preview });
  let proxyRunning = false, unsafeBinding = false;
  const runDocker = args => {
    f.commands.push(args);
    if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64", ServerVersion: "29.9.3", DockerRootDir: f.root }) };
    if (args[0] === "network") return { stdout: JSON.stringify(previewNetworks()) };
    if (args.includes("config")) {
      const privateMode = readFileSync(join(f.directory, "closed.yaml"), "utf8").includes("MQ_TLS_MODE: private");
      return { stdout: JSON.stringify(privateMode ? privateCompose(f.context.config, images, preview) : composeSpec(f.context.config, images)) };
    }
    if (args.includes("up") && args.at(-1) === "proxy") proxyRunning = true;
    if (args.includes("stop") && args.at(-1) === "proxy") proxyRunning = false;
    if (args.includes("ps")) return { stdout: proxyRunning ? "d".repeat(64) : "" };
    if (args[0] === "inspect") return { stdout: JSON.stringify([{ Config: { Labels: { "com.docker.compose.project": "mq-production",
      "com.docker.compose.service": "proxy" } }, State: { Running: proxyRunning }, HostConfig: { PortBindings: { "443/tcp": [{ HostIp: unsafeBinding ? "0.0.0.0" : "127.0.0.1", HostPort: "18443" }] } },
      NetworkSettings: { Ports: { "80/tcp": null, "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "18443" }] } } }]) };
    return { stdout: "" };
  };
  const options = { runDocker, inspectSpace, inspectPrivateRouting: async () => true,
    probePrivateHttps: async input => { assert.equal(input.preview.host, "127.0.0.1"); return true; },
    claimOperation: value => claimProductionOperation(value, { directory: f.root }) };
  let priorReceipt = f.context.priorReceipt;
  for (const action of ["private-preview", "close-preview"]) {
    const plan = action === "private-preview" ? opened : planProductionPreviewClose({ currentRelease: f.context.release, config: f.context.config, receipt: priorReceipt });
    const now = Date.now(); await chmod(f.context.settings.approvalFile, 0o600);
    await writeFile(f.context.settings.approvalFile, JSON.stringify({ version: 1, planId: plan.planId, action, sourceSha,
      deploymentId: plan.deploymentId, approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() }));
    await chmod(f.context.settings.approvalFile, 0o400);
    const result = await applyProductionHost({ ...f.context, plan, priorReceipt }, `${action}:${plan.deploymentId}:${plan.planId}`, options);
    assert.equal(result.receipt.privateIngress, action === "private-preview");
    assert.equal(result.receipt.publicIngress, false);
    priorReceipt = result.receipt;
  }
  assert.equal(proxyRunning, false);
  assert.equal(priorReceipt.previewSessionsRevoked, true);
  assert.deepEqual(priorReceipt.features, disabled);
  assert.equal(readFileSync(join(f.directory, "closed.yaml"), "utf8"), "services:\n  proxy:\n    ports: !reset []\n");
  assert.deepEqual(f.commands.filter(args => args.includes("scripts/production/rotation-cli.mjs")).map(args => args.at(-2)), ["pause", "revoke-sessions", "resume"]);
  assert.ok(!f.commands.some(args => args.includes("load")), "Preview uses the already loaded reviewed release");
  const bad = planProductionPrivatePreview({ currentRelease: f.context.release, config: f.context.config, receipt: priorReceipt, preview });
  const now = Date.now(); await chmod(f.context.settings.approvalFile, 0o600);
  await writeFile(f.context.settings.approvalFile, JSON.stringify({ version: 1, planId: bad.planId, action: bad.action,
    sourceSha, deploymentId: bad.deploymentId, approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() }));
  await chmod(f.context.settings.approvalFile, 0o400);
  unsafeBinding = true;
  await assert.rejects(applyProductionHost({ ...f.context, plan: bad, priorReceipt },
    `${bad.action}:${bad.deploymentId}:${bad.planId}`, options), /INGRESS_CLOSED/);
  assert.equal(proxyRunning, false, "Actual non-loopback binding closes the proxy instead of issuing a preview receipt");
  assert.deepEqual(await readProductionReceipt(join(f.directory, "receipt.json")), priorReceipt);
});
