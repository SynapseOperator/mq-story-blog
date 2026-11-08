import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, realpath, readFile, writeFile, mkdir, rename, statfs, chown, open } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { readDeploymentFile, readDeploymentManifest } from "../production/runtime-config.mjs";
import { readBackupReceipt } from "../production/backup-window.mjs";
import { claimProductionOperation } from "../production/operation-lock.mjs";
import { assertDatabaseUrl, LOGIN_IDENTITIES } from "../production/database-config.mjs";
import { verifyReleaseBundle, releaseCompatibility, TARGETS, sha256 } from "./bundle.mjs";
import { planProductionBootstrap, planProductionChange, planProductionActivation, executeProductionPlan } from "./production-plan.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
const reserve = 8 * 1024 ** 3;
const secretOwners = { postgres_password: 999, database_url: 10001, auth_secret: 10001, session_storage_key: 10001,
  auth_proxy_secret: 10001, publish_signing_key: 10001, comment_signing_key: 10001,
  bootstrap_database_url: 10001, migration_database_url: 10001, role_passwords: 10001 };

function docker(args, { fail = true, timeout = 300000 } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 ** 2 });
  if (fail && (result.error || result.status !== 0)) throw new Error("PRODUCTION_DOCKER_FAILED");
  return result;
}

export function validateHostSettings(value, config) {
  assert.deepEqual(Object.keys(value).sort(), ["approvalFile", "candidateDirectory", "candidateManifestSha256", "deploymentFile", "features", "gateFile", "secretDirectory", "targetDirectory", "version"]);
  assert.equal(value.version, 1);
  assert.equal(config.environment, "production");
  assert.equal(value.targetDirectory, `/srv/mq-production/${config.deploymentId}`);
  assert.deepEqual(Object.keys(value.features).sort(), ["auth", "comments", "media", "publishing"]);
  for (const enabled of Object.values(value.features)) assert.equal(typeof enabled, "boolean");
  for (const name of ["approvalFile", "candidateDirectory", "deploymentFile", "gateFile", "secretDirectory"])
    assert.ok(typeof value[name] === "string" && /^\/[A-Za-z0-9_./-]+$/.test(value[name]) && posix.normalize(value[name]) === value[name]);
  assert.match(value.candidateManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(config.database.host, "postgres"); assert.equal(config.database.port, 5432);
  assert.equal(config.media.root, "/var/lib/mq/media");
  assert.ok(config.media.minFreeBytes >= reserve);
  return value;
}

export function validateCurrentReleaseGate(gate, sourceSha, now = Date.now()) {
  assert.equal(gate.kind, "reviewed-main", "PRODUCTION_CURRENT_REVIEW_REQUIRED");
  assert.equal(gate.repository, "SynapseOperator/mq-story-blog", "PRODUCTION_CURRENT_REVIEW_REQUIRED");
  assert.equal(gate.sourceSha, sourceSha, "PRODUCTION_CURRENT_REVIEW_REQUIRED");
  for (const key of ["sourceSha", "observedMainSha", "reviewedHead"]) assert.match(gate[key], /^[a-f0-9]{40}$/);
  assert.equal(gate.reviewer, "SnorkelingBreather", "PRODUCTION_CURRENT_REVIEW_REQUIRED");
  for (const key of ["pullRequest", "reviewId", "qualityRunId"]) assert.ok(Number.isSafeInteger(gate[key]) && gate[key] > 0);
  const checked = Date.parse(gate.checkedAt);
  assert.ok(Number.isFinite(checked) && checked <= now && now - checked <= 60 * 60 * 1000, "PRODUCTION_CURRENT_REVIEW_EXPIRED");
}

async function privateDirectory(path) {
  assert.equal(await realpath(path), path, "PRODUCTION_PATH_REJECTED");
  const info = await lstat(path);
  assert.ok(info.isDirectory(), "PRODUCTION_PRIVATE_DIRECTORY_REQUIRED");
  if (process.platform !== "win32") assert.ok(info.uid === 0 && (info.mode & 0o7777) === 0o700, "PRODUCTION_PRIVATE_DIRECTORY_REQUIRED");
}

export async function readSecrets(directory, config) {
  await privateDirectory(directory);
  const values = {};
  for (const [name, uid] of Object.entries(secretOwners)) {
    const path = join(directory, name), info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === uid
      && [0o400, 0o600].includes(info.mode & 0o7777) && info.size > 0 && info.size <= 4096, "PRODUCTION_SECRET_FILE_REJECTED");
    values[name] = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  }
  for (const [file, identity] of [["database_url", "runtime"], ["bootstrap_database_url", "bootstrap"], ["migration_database_url", "migration"]])
    assertDatabaseUrl(values[file], config, identity);
  const passwords = JSON.parse(values.role_passwords);
  assert.deepEqual(Object.keys(passwords).sort(), [...LOGIN_IDENTITIES].sort());
  for (const password of Object.values(passwords)) assert.match(password, /^[A-Za-z0-9_-]{32,128}$/);
  assert.match(values.postgres_password, /^[A-Za-z0-9_-]{32,128}$/, "PRODUCTION_BOOTSTRAP_PASSWORD_REJECTED");
  const bootstrap = new URL(values.bootstrap_database_url);
  assert.equal(decodeURIComponent(bootstrap.username), "mq_bootstrap");
  assert.equal(decodeURIComponent(bootstrap.password), values.postgres_password);
  assert.equal(decodeURIComponent(new URL(values.database_url).password), passwords.runtime);
  assert.equal(decodeURIComponent(new URL(values.migration_database_url).password), passwords.migration);
  const keys = ["auth_secret", "session_storage_key", "auth_proxy_secret", "publish_signing_key", "comment_signing_key"].map(name => values[name]);
  for (const key of keys) assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(new Set([...Object.values(passwords), values.postgres_password, ...keys]).size, LOGIN_IDENTITIES.length + 1 + keys.length,
    "PRODUCTION_SECRET_REUSE_REJECTED");
  // Contents never enter state, Docker argv, output, or the approval record.
}

export function assertProductionCompose(spec, { images, config, openIngress = false }) {
  assert.equal(spec.name, "mq-production");
  for (const name of ["app", "tools", "proxy"]) {
    assert.equal(spec.services[name].image, images[name]);
    assert.equal(spec.services[name].user, "10001:10001");
    assert.equal(spec.services[name].read_only, true);
    assert.ok(!spec.services[name].privileged && !spec.services[name].network_mode);
  }
  assert.match(spec.services.postgres.image, /^postgres:18\.[^@]+@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(spec.services).filter(name => spec.services[name].ports?.length), openIngress ? ["proxy"] : []);
  if (openIngress) assert.deepEqual(spec.services.proxy.ports.map(p => [Number(p.published), Number(p.target)]).sort((a,b)=>a[0]-b[0]), [[80,80],[443,443]]);
  for (const name of ["frontend", "database"]) assert.equal(spec.networks[name].internal, true);
  assert.equal(spec.services.app.environment.MQ_DEPLOYMENT_ENV, "production");
  assert.equal(spec.services.app.environment.AUTH_ORIGIN, config.origin);
  assert.equal(spec.services.proxy.environment.MQ_TLS_MODE, "public");
  assert.equal(Number(spec.services.app.mem_limit), 1536 * 1024 ** 2);
  assert.equal(Number(spec.services.postgres.mem_limit), 768 * 1024 ** 2);
  assert.ok(spec.services.postgres.volumes.some(v => v.target === "/var/lib/postgresql"));
}

async function writeControlFile(path, bytes) {
  const temporary = `${path}.next`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function publicHttpsHealthy(origin) {
  // Public trust store and hostname checks stay on. No local CA override.
  for (let attempt = 0; attempt < 60; attempt++) {
    const ok = await new Promise(done => {
      const request = https.get(new URL("/api/stories", origin), { timeout: 3000 }, response => { response.resume(); done(response.statusCode === 200); });
      request.on("error", () => done(false)); request.on("timeout", () => request.destroy());
    });
    if (ok) return true; await delay(1000);
  }
  return false;
}

// A receipt includes four OCI manifests and nine migrations, so it is larger
// than a secret. Keep the 4 KiB secret limit; use a separate private 64 KiB cap.
export async function readProductionReceipt(path) {
  await privateDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await file.stat();
    assert.ok(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 65536, "PRODUCTION_RECEIPT_FILE_REJECTED");
    if (process.platform !== "win32") assert.ok(info.uid === 0 && (info.mode & 0o7777) === 0o600, "PRODUCTION_RECEIPT_FILE_REJECTED");
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    assert.equal(count, info.size, "PRODUCTION_RECEIPT_FILE_REJECTED");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } finally { await file.close(); }
}

export async function prepareProductionHost(settingsFile, action, { verify = verifyReleaseBundle } = {}) {
  assert.equal(process.platform, "linux", "PRODUCTION_HOST_LINUX_REQUIRED");
  assert.equal(process.getuid(), 0, "PRODUCTION_HOST_ROOT_REQUIRED");
  assert.ok(["bootstrap", "upgrade", "rollback", "activate"].includes(action));
  const settings = JSON.parse(await readDeploymentFile(settingsFile));
  const config = await readDeploymentManifest(settings.deploymentFile);
  const manifest = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "roles"));
  validateHostSettings(settings, config);
  await privateDirectory(dirname(settings.targetDirectory));
  await readSecrets(settings.secretDirectory, config);
  const release = await verify(settings.candidateDirectory, settings.candidateManifestSha256);
  // Generated on the operator's workstation by the live GitHub gate command.
  // This root-owned offline record is not a signature or a substitute for the
  // operator's approval; no GitHub token is copied to the host.
  validateCurrentReleaseGate(JSON.parse(await readDeploymentFile(settings.gateFile)), release.sourceSha);
  assert.deepEqual(release.compatibility, await releaseCompatibility(source), "PRODUCTION_TOOL_CONTRACT_MISMATCH");
  let receipt, currentRelease;
  if (action !== "bootstrap") {
    await privateDirectory(settings.targetDirectory);
    receipt = await readProductionReceipt(join(settings.targetDirectory, "receipt.json"));
    assert.equal(receipt.deploymentId, config.deploymentId);
    assert.equal(receipt.configSha256, sha256(JSON.stringify(config)), "PRODUCTION_TARGET_CHANGED");
    currentRelease = receipt.release;
  }
  const plan = action === "bootstrap"
    ? planProductionBootstrap({ release, config: manifest, candidateManifestSha256: settings.candidateManifestSha256 })
    : action === "activate"
      ? planProductionActivation({ currentRelease, config: manifest, receipt, features: settings.features })
      : planProductionChange({ release, currentRelease, config: manifest, candidateManifestSha256: settings.candidateManifestSha256,
        backupReceipt: await readBackupReceipt(join(settings.targetDirectory, "backup-receipts", "latest.json")), mode: action, features: settings.features });
  if (action === "bootstrap") assert.ok(Object.values(settings.features).every(value => value === false), "PRODUCTION_BOOTSTRAP_FEATURES_DISABLED");
  if (action === "activate") {
    assert.deepEqual(release, receipt.release, "PRODUCTION_ACTIVATION_RELEASE_CHANGED");
    assert.equal(settings.candidateManifestSha256, receipt.candidateManifestSha256, "PRODUCTION_ACTIVATION_RELEASE_CHANGED");
  }
  return { settings, config, release, plan, priorReceipt: receipt };
}

/** Fixed host executor. There is deliberately no arbitrary shell hook or
 * operator-supplied compose override. Planning never writes host state. */
export async function applyProductionHost(context, confirmation, { runDocker = docker, claimOperation = claimProductionOperation,
  inspectSpace = statfs, probeHttps = publicHttpsHealthy } = {}) {
  const { settings, config, plan, release, priorReceipt } = context;
  const approval = JSON.parse(await readDeploymentFile(settings.approvalFile));
  const directory = settings.targetDirectory;
  const images = Object.fromEntries(TARGETS.map(name => [name, release.images[name].indexDigest]));
  const base = ["compose", "--project-name", "mq-production", "--env-file", join(directory, "compose.env"),
    "-f", join(source, "compose.production.yaml"), "-f", join(directory, "closed.yaml")];
  const compose = (args, options) => runDocker([...base, ...args], options);
  let prepared = false, claim, targetOwned = false, claimAttempted = false;
  const operation = (name, identity, extra = []) => {
    const args = ["run", "--rm", "--no-deps"];
    const mounts = identity === "bootstrap" ? ["bootstrap_database_url", ...(name === "bootstrap" ? ["role_passwords"] : []),
      ...(name === "keys" ? ["publish_signing_key", "comment_signing_key"] : [])]
      : [identity === "runtime" ? "database_url" : "migration_database_url"];
    for (const file of mounts) args.push("-v", `${join(settings.secretDirectory, file)}:/run/operation/${file}:ro`);
    args.push("-e", `${identity.toUpperCase()}_DATABASE_URL_FILE=/run/operation/${identity === "runtime" ? "database_url" : `${identity}_database_url`}`);
    if (name === "bootstrap") args.push("-e", "MQ_ROLE_PASSWORDS_FILE=/run/operation/role_passwords");
    if (name === "keys") args.push("-e", "MQ_PUBLISH_SIGNING_KEY_FILE=/run/operation/publish_signing_key", "-e", "MQ_COMMENT_SIGNING_KEY_FILE=/run/operation/comment_signing_key");
    return compose([...args, "tools", "scripts/production/database-cli.mjs", name,
      ...(name === "audit" ? [] : [`--confirm-production=${config.deploymentId}`]), ...extra]);
  };
  async function writeEnvironment(features) {
    const env = { MQ_DEPLOYMENT_ENV: "production", MQ_DATABASE_NAME: "mq_production", MQ_AUTH_ORIGIN: config.origin,
      MQ_PUBLIC_HOST: new URL(config.origin).hostname, MQ_DEPLOYMENT_CONFIG: settings.deploymentFile,
      MQ_SECRET_DIRECTORY: settings.secretDirectory, MQ_APP_IMAGE: images.app, MQ_TOOLS_IMAGE: images.tools, MQ_PROXY_IMAGE: images.proxy,
      MQ_AUTH_ENABLED: String(features.auth), MQ_MEDIA_ENABLED: String(features.media), MQ_PUBLISH_ENABLED: String(features.publishing), MQ_COMMENTS_ENABLED: String(features.comments) };
    for (const value of Object.values(env)) assert.ok(!/[\s\0$#'"\\]/.test(value), "PRODUCTION_ENVIRONMENT_REJECTED");
    await writeControlFile(join(directory, "compose.env"), Object.entries(env).map(([k,v]) => `${k}=${v}`).join("\n") + "\n");
  }
  const execute = async step => {
    if (step === "preflight") {
      const info = JSON.parse(runDocker(["info", "--format", "{{json .}}"] ).stdout);
      assert.equal(info.OSType, "linux"); assert.ok(["amd64", "x86_64"].includes(info.Architecture));
      for (const path of [dirname(directory), info.DockerRootDir]) {
        const space = await inspectSpace(path);
        const extra = plan.action === "activate" ? 0 : Object.values(release.images).reduce((n,i)=>n+i.archiveBytes,0)*2;
        assert.ok(space.bavail * space.bsize >= reserve + extra, "PRODUCTION_DISK_RESERVE_LOW");
        assert.ok(space.files === 0 || space.ffree / space.files >= 0.05, "PRODUCTION_INODES_LOW");
      }
      if (plan.action === "bootstrap") {
        let exists = false; try { await lstat(directory); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
        assert.equal(exists, false, "PRODUCTION_EXISTING_TARGET_REJECTED");
        for (const args of [["ps", "-aq", "--filter", "label=com.docker.compose.project=mq-production"],
          ["volume", "ls", "-q", "--filter", "name=mq-production"], ["network", "ls", "-q", "--filter", "name=mq-production"]])
          assert.equal(runDocker(args).stdout.trim(), "", "PRODUCTION_EXISTING_RESOURCES_REJECTED");
      } else {
        const marker = JSON.parse(await readDeploymentFile(join(directory, "target.json"), { secret: true }));
        assert.deepEqual(marker, { version: 1, deploymentId: config.deploymentId, project: "mq-production" });
        if (priorReceipt.publicIngress === false) {
          const ids = compose(["ps", "--all", "--quiet", "proxy"]).stdout.trim().split(/\s+/).filter(Boolean);
          assert.ok(ids.length <= 1, "PRODUCTION_PROXY_STATE_REJECTED");
          if (ids.length) {
            assert.match(ids[0], /^[a-f0-9]{12,64}$/);
            const containers = JSON.parse(runDocker(["inspect", ...ids]).stdout);
            assert.equal(containers.length, 1);
            assert.equal(containers[0].Config.Labels["com.docker.compose.project"], "mq-production");
            assert.equal(containers[0].Config.Labels["com.docker.compose.service"], "proxy");
            assert.equal(containers[0].State.Running, false, "PRODUCTION_CLOSED_RECEIPT_CONTRADICTED");
          }
        }
      }
      return true;
    }
    // Activation's first audit is genuinely read-only. No lock, env file or
    // service state is changed until the following app step.
    if (!prepared && plan.action === "activate" && step === "audit") {
      operation("audit", "runtime"); return;
    }
    if (!claim) {
      // A failed claim must not be retried by the plan's containment callbacks:
      // the project might belong to the operation that won the lock.
      assert.equal(claimAttempted, false, "PRODUCTION_OPERATION_NOT_OWNED");
      claimAttempted = true;
      claim = await claimOperation({ deploymentId: config.deploymentId, kind: "release", operationId: plan.planId });
      if (plan.action !== "bootstrap") {
        // Another completed operation between preflight and claim invalidates
        // this snapshot. Do not stop a newly updated deployment on its behalf.
        assert.deepEqual(await readProductionReceipt(join(directory, "receipt.json")), priorReceipt, "PRODUCTION_CURRENT_RELEASE_CHANGED");
        const marker = JSON.parse(await readDeploymentFile(join(directory, "target.json"), { secret: true }));
        assert.deepEqual(marker, { version: 1, deploymentId: config.deploymentId, project: "mq-production" });
        targetOwned = true;
      }
    }
    await claim.assertOwned();
    if (!prepared && !["close-ingress", "stop-app"].includes(step)) {
      if (plan.action === "bootstrap") {
        await mkdir(directory, { mode: 0o700 });
        targetOwned = true;
        await writeFile(join(directory, "target.json"), JSON.stringify({ version: 1, deploymentId: config.deploymentId, project: "mq-production" }), { flag: "wx", mode: 0o600 });
        await mkdir(join(directory, "backup-receipts"), { mode: 0o700 });
        await chown(join(directory, "backup-receipts"), 10001, 10001);
      }
      if (plan.action !== "activate") for (const name of TARGETS) {
        runDocker(["image", "load", "--input", join(settings.candidateDirectory, release.images[name].file)], { timeout: 600000 });
        const image = JSON.parse(runDocker(["image", "inspect", `mq-release-${name}:${release.sourceSha}`, "--format", "{{json .Descriptor}}"] ).stdout);
        assert.equal(image.digest, images[name], "PRODUCTION_LOADED_IMAGE_MISMATCH");
      }
      await writeEnvironment(plan.features);
      await writeControlFile(join(directory, "closed.yaml"), "services:\n  proxy:\n    ports: !reset []\n");
      assertProductionCompose(JSON.parse(compose(["config", "--format", "json"]).stdout), { images, config });
      prepared = true;
    }
    switch (step) {
      case "close-ingress": assert.ok(targetOwned, "PRODUCTION_TARGET_NOT_OWNED"); compose(["stop", "proxy"]); return;
      case "stop-app": assert.ok(targetOwned, "PRODUCTION_TARGET_NOT_OWNED"); compose(["stop", "app"]); return;
      case "postgres": compose(["up", "-d", "--wait", "--wait-timeout", "180", "postgres"]); return;
      case "bootstrap": operation("bootstrap", "bootstrap"); return;
      case "migrate": operation("migrate", "migration"); return;
      case "provision": operation("provision", "bootstrap"); return;
      case "keys": operation("keys", "bootstrap"); return;
      case "audit": operation("audit", "runtime"); return;
      case "volumes-init": compose(["run", "--rm", "--no-deps", "volumes-init"]); return;
      case "media-init": compose(["run", "--rm", "--no-deps", "tools", "scripts/production/init-media.mjs"]); return;
      case "app": compose(["up", "-d", "--wait", "--wait-timeout", "180", "app"]); return;
      case "health": compose(["exec", "-T", "app", "node", "scripts/production/healthcheck.mjs"]); return true;
      case "open-ingress": {
        // Only the separate activate plan can reach this step. This file is
        // never written by bootstrap/upgrade/rollback, including on success.
        assert.equal(plan.action, "activate");
        await writeControlFile(join(directory, "closed.yaml"), "services:\n  proxy:\n    ports: !override [\"80:80\", \"443:443\"]\n");
        assertProductionCompose(JSON.parse(compose(["config", "--format", "json"]).stdout), { images, config, openIngress: true });
        compose(["up", "-d", "--wait", "--wait-timeout", "180", "proxy"]); return;
      }
      case "https": return probeHttps(config.origin);
      case "receipt": {
        const receipt = { version: 1, verified: true, deploymentId: config.deploymentId, sourceSha: release.sourceSha,
          candidateManifestSha256: settings.candidateManifestSha256, completedAt: new Date().toISOString(), action: plan.action,
          features: plan.features, publicIngress: plan.action === "activate", configSha256: sha256(JSON.stringify(config)),
          release, previousSourceSha: priorReceipt?.sourceSha ?? null, planId: plan.planId };
        if (priorReceipt) await writeFile(join(directory, `receipt-${priorReceipt.planId}.json`), JSON.stringify(priorReceipt), { flag: "wx", mode: 0o600 });
        await writeControlFile(join(directory, "receipt.json"), JSON.stringify(receipt));
        // Preserve the operation record rather than deleting evidence.
        await claim.complete(directory);
        return receipt;
      }
      default: throw new Error("PRODUCTION_STEP_REJECTED");
    }
  };
  return executeProductionPlan({ plan, approval, confirmation, execute });
}
