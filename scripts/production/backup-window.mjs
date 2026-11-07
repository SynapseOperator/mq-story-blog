import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { pathToFileURL } from "node:url";
import { privatePath, writePrivate } from "../media/backup-files.mjs";
import { readDeploymentFile, readDeploymentManifest } from "./runtime-config.mjs";
import { runBackupTool } from "./backup-tools.mjs";
import { claimProductionOperation, confirmInterruptedBackup } from "./operation-lock.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// A locally verified OCI index may be loaded by its content digest without a
// registry repository name. Both forms are immutable; mutable tags still fail.
const digestImage = /^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/;
const runDocker = args => runBackupTool("docker", args, { timeoutMs: 900_000 });

/** Only nonsecret backup receipt metadata crosses from tools UID10001 to the
 * root host coordinator. Secret-file ownership rules remain unchanged. */
export async function readBackupReceipt(path) {
  try {
    await privatePath(path, { directory: false });
    const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const info = await handle.stat();
      assert.ok(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 4096);
      if (process.platform !== "win32") assert.ok([0, 10001, process.geteuid()].includes(info.uid) && (info.mode & 0o7777) === 0o600);
      const bytes = Buffer.alloc(info.size + 1); let count = 0;
      while (count < bytes.length) {
        const part = await handle.read(bytes, count, bytes.length - count, count);
        if (!part.bytesRead) break;
        count += part.bytesRead;
      }
      assert.equal(count, info.size);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
    } finally { await handle.close(); }
  } catch { throw new Error("BACKUP_WINDOW_RECEIPT_REJECTED"); }
}

export async function readBackupWindowConfiguration(file, confirmation) {
  try {
    const value = JSON.parse(await readDeploymentFile(file));
    assert.equal(Object.keys(value).sort().join(","),
      "composeEnvironmentFile,deploymentFile,deploymentId,overrideFile,project,receiptDirectory,releaseDirectory,version");
    assert.equal(value.version, 1); assert.match(value.deploymentId, uuid);
    assert.equal(confirmation, `--confirm-deployment=${value.deploymentId}`);
    for (const name of ["composeEnvironmentFile", "deploymentFile", "overrideFile", "receiptDirectory", "releaseDirectory"])
      assert.ok(typeof value[name] === "string" && isAbsolute(value[name]));
    const deployment = await readDeploymentManifest(value.deploymentFile);
    assert.equal(deployment.deploymentId, value.deploymentId);
    assert.equal(value.project, `mq-${deployment.environment}`);
    await readDeploymentFile(value.composeEnvironmentFile, { secret: true });
    await readDeploymentFile(value.overrideFile);
    await privatePath(value.receiptDirectory);
    return { ...value, deployment };
  } catch { throw new Error("BACKUP_WINDOW_CONFIG_REJECTED"); }
}

async function publishStatus(config, name, value) {
  const destination = join(config.receiptDirectory, name);
  let exists = false;
  try { await lstat(destination); exists = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists) {
    const prior = JSON.parse(await readDeploymentFile(destination, { secret: true }));
    assert.equal(prior.deploymentId, config.deploymentId);
  }
  const temporary = join(config.receiptDirectory, `.status-${randomUUID()}`);
  await writePrivate(temporary, Buffer.from(JSON.stringify(value)));
  try { await rename(temporary, destination); }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

/** Fixed maintenance sequence. The injected runner is for deterministic
 * failure tests; production only executes Docker with fixed argument arrays. */
export async function runBackupWindow(config, { run = runDocker, interrupted = () => false, closeOnly = false,
  claimOperation = claimProductionOperation, confirmInterrupted = confirmInterruptedBackup } = {}) {
  const base = ["compose", "--project-name", config.project, "--env-file", config.composeEnvironmentFile,
    "-f", join(config.releaseDirectory, "compose.production.yaml"), "-f", config.overrideFile];
  const compose = args => run([...base, ...args]);
  const operation = (script, action, extra = []) => compose(["run", "--rm", "--no-deps", ...extra,
    "tools", `scripts/production/${script}-cli.mjs`, action, `--confirm-deployment=${config.deploymentId}`]);
  const lock = join(config.receiptDirectory, "backup-window.lock");
  let ownedLock = false, changed = false, success = false, phase = "preflight", productionClaim;
  const checkInterruption = () => { if (interrupted()) throw new Error("BACKUP_WINDOW_INTERRUPTED"); };
  try {
    // Resolve configuration without printing it: it may contain private paths.
    const spec = JSON.parse(await compose(["config", "--format", "json"]));
    assert.equal(spec.name, config.project);
    assert.equal(resolve(spec.configs.deployment.file), resolve(config.deploymentFile));
    for (const name of ["app", "proxy", "postgres", "tools"]) assert.match(spec.services[name].image, digestImage);
    const tools = spec.services.tools;
    assert.equal(tools.user, "10001:10001"); assert.equal(tools.read_only, true);
    assert.ok(!tools.ports?.length);
    assert.ok(!tools.privileged);
    if (tools.entrypoint !== undefined) assert.deepEqual(tools.entrypoint, ["node"]);
    const allowed = new Set(["MQ_DEPLOYMENT_ENV", "MQ_DEPLOYMENT_CONFIG", "MQ_BACKUP_BACKEND", "MQ_BACKUP_REPOSITORY",
      "MQ_BACKUP_PASSWORD_FILE", "MQ_BACKUP_WORKSPACE", "MQ_BACKUP_REPOSITORY_ID", "MQ_BACKUP_S3_REGION",
      "MQ_BACKUP_S3_CREDENTIALS_FILE", "MQ_BACKUP_CA_CERT_FILE", "MQ_BACKUP_SOURCE_REVISION",
      "BOOTSTRAP_DATABASE_URL_FILE", "BACKUP_DATABASE_URL_FILE"]);
    assert.ok(Object.keys(tools.environment).every(name => allowed.has(name)));
    assert.equal(tools.environment.MQ_DEPLOYMENT_ENV, config.deployment.environment);
    assert.equal(tools.environment.MQ_DEPLOYMENT_CONFIG, "/etc/mq/deployment.json");
    assert.ok(tools.configs?.some(item => item.source === "deployment" && item.target === "/etc/mq/deployment.json"));
    assert.match(tools.environment.MQ_BACKUP_SOURCE_REVISION ?? "", /^[a-f0-9]{40}$/);
    assert.ok(tools.volumes.some(volume => volume.type === "bind" && volume.target === "/var/lib/mq/backup-status"
      && resolve(volume.source) === resolve(config.receiptDirectory) && !volume.read_only));
    const ids = (await compose(["ps", "--all", "--quiet", "app", "proxy", "postgres"])).trim().split(/\s+/);
    assert.equal(ids.length, 3); ids.forEach(id => assert.match(id, /^[a-f0-9]{12,64}$/));
    const containers = JSON.parse(await run(["inspect", ...ids]));
    assert.equal(containers.length, 3);
    const seen = new Set();
    for (const container of containers) {
      const labels = container.Config.Labels, service = labels["com.docker.compose.service"];
      assert.equal(labels["com.docker.compose.project"], config.project);
      assert.ok(["app", "proxy", "postgres"].includes(service) && !seen.has(service)); seen.add(service);
      assert.equal(container.Config.Image, spec.services[service].image);
      if (!closeOnly) {
        assert.equal(container.State.Running, true);
        if (service !== "proxy") assert.equal(container.State.Health?.Status, "healthy");
      }
    }
    if (config.deployment.environment === "production") {
      if (closeOnly) await confirmInterrupted(config.deploymentId);
      else productionClaim = await claimOperation({ deploymentId: config.deploymentId, kind: "backup", operationId: randomUUID() });
      // Release and backup preflights can overlap; after obtaining ownership,
      // recheck that no intervening release changed the inspected target.
      assert.deepEqual(JSON.parse(await compose(["config", "--format", "json"])), spec);
      assert.deepEqual((await compose(["ps", "--all", "--quiet", "app", "proxy", "postgres"])).trim().split(/\s+/), ids);
    }
    if (!closeOnly) { await mkdir(lock, { mode: 0o700 }); ownedLock = true; }
    checkInterruption(); changed = true; phase = "stop";
    await compose(["stop", "proxy", "app"]);
    phase = "pause"; await operation("rotation", "pause");
    if (closeOnly) {
      await publishStatus(config, "backup-failure.json", {
        deploymentId: config.deploymentId, checkedAt: new Date().toISOString(), failures: ["BACKUP_FAILED"],
      });
      return { closed: true, deploymentId: config.deploymentId };
    }
    checkInterruption(); phase = "backup";
    const receiptName = `${randomUUID()}.json`;
    const output = JSON.parse(await operation("backup", "backup", ["-e", `MQ_BACKUP_RECEIPT=/var/lib/mq/backup-status/${receiptName}`]));
    const receipt = await readBackupReceipt(join(config.receiptDirectory, receiptName));
    assert.equal(receipt.verified, true); assert.equal(receipt.deploymentId, config.deploymentId);
    assert.match(receipt.snapshotId, /^[a-f0-9]{64}$/);
    assert.equal(receipt.snapshotId, output.snapshotId); assert.equal(output.verified, true);
    assert.equal(receipt.sourceRevision, tools.environment.MQ_BACKUP_SOURCE_REVISION);
    assert.ok(Number.isFinite(Date.parse(receipt.completedAt)));
    await publishStatus(config, "latest.json", receipt);
    checkInterruption(); phase = "resume"; await operation("rotation", "resume");
    checkInterruption(); phase = "start"; await compose(["up", "-d", "--wait", "app", "proxy"]);
    checkInterruption();
    if (productionClaim) await productionClaim.complete();
    success = true;
    return { completed: true, deploymentId: config.deploymentId, snapshotId: receipt.snapshotId, entryRestored: true };
  } catch {
    let closureConfirmed = false;
    if (changed) {
      // A failed resume/start must not leave the entry open. Both commands are
      // scoped to already-inspected containers and the confirmed DB manifest.
      const stopped = await compose(["stop", "proxy", "app"]).then(() => true, () => false);
      const paused = await operation("rotation", "pause").then(() => true, () => false);
      closureConfirmed = stopped && paused;
    }
    if (ownedLock || closeOnly) await publishStatus(config, "backup-failure.json", {
      deploymentId: config.deploymentId, checkedAt: new Date().toISOString(), failures: ["BACKUP_FAILED"],
    }).catch(() => {});
    throw Object.assign(new Error("BACKUP_WINDOW_FAILED"), { phase, closureConfirmed, manualRecoveryRequired: changed });
  } finally {
    // Failure intentionally leaves this specific lock for operator inspection.
    if (ownedLock && success) await rmdir(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let interrupted = false;
  process.on("SIGTERM", () => { interrupted = true; });
  process.on("SIGINT", () => { interrupted = true; });
  try {
    const [action, confirmation, ...extra] = process.argv.slice(2);
    assert.ok(["run", "close-after-failure"].includes(action) && !extra.length);
    if (action !== "close-after-failure" || process.env.SERVICE_RESULT !== "success") {
      const config = await readBackupWindowConfiguration(process.env.MQ_BACKUP_WINDOW_CONFIG, confirmation);
      console.log(JSON.stringify(await runBackupWindow(config, { interrupted: () => interrupted, closeOnly: action === "close-after-failure" })));
    }
  } catch (error) {
    console.error(JSON.stringify({ error: "BACKUP_WINDOW_FAILED", phase: error.phase ?? "configuration",
      closureConfirmed: error.closureConfirmed === true, manualRecoveryRequired: error.manualRecoveryRequired === true }));
    process.exitCode = 1;
  }
}
