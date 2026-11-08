import assert from "node:assert/strict";
import { lstat, realpath, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

// The one production Compose project must not be changed by a scheduled backup
// and a release at the same time. Failure keeps the record for manual recovery.
export const PRODUCTION_OPERATION_DIRECTORY = "/srv/mq-production";

async function operationDirectory(directory) {
  assert.equal(await realpath(directory), directory, "PRODUCTION_OPERATION_PATH_REJECTED");
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "PRODUCTION_OPERATION_PATH_REJECTED");
  if (process.platform !== "win32") assert.ok(process.geteuid() === 0 && info.uid === 0
    && (info.mode & 0o7777) === 0o700, "PRODUCTION_OPERATION_OWNER_REQUIRED");
}

async function lockRecord(path) {
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 1024,
    "PRODUCTION_OPERATION_RECORD_REJECTED");
  if (process.platform !== "win32") assert.ok(info.uid === 0 && (info.mode & 0o7777) === 0o600,
    "PRODUCTION_OPERATION_OWNER_REQUIRED");
  const record = JSON.parse(await readFile(path, "utf8"));
  assert.equal(record.version, 1);
  assert.match(record.deploymentId, /^[a-f0-9-]{36}$/);
  assert.ok(["release", "backup"].includes(record.kind));
  assert.match(record.operationId, /^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/);
  assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0);
  return record;
}

export async function claimProductionOperation({ deploymentId, kind, operationId },
  { directory = PRODUCTION_OPERATION_DIRECTORY } = {}) {
  await operationDirectory(directory);
  assert.match(deploymentId, /^[a-f0-9-]{36}$/);
  assert.ok(["release", "backup"].includes(kind));
  assert.match(operationId, /^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/);
  const path = join(directory, "operation.lock");
  const record = { version: 1, deploymentId, kind, operationId, pid: process.pid, startedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  return {
    async assertOwned() { assert.deepEqual(await lockRecord(path), record, "PRODUCTION_OPERATION_OWNERSHIP_LOST"); },
    async complete(archiveDirectory = directory) {
      assert.deepEqual(await lockRecord(path), record, "PRODUCTION_OPERATION_OWNERSHIP_LOST");
      await operationDirectory(archiveDirectory);
      const destination = join(archiveDirectory, `operation-${operationId}.json`);
      await lstat(destination).then(() => { throw new Error("PRODUCTION_OPERATION_RECORD_EXISTS"); },
        error => { if (error.code !== "ENOENT") throw error; });
      await rename(path, destination);
    },
  };
}

/** systemd's failure handler may close its own interrupted backup, never a
 * release or a different/live backup. No automatic unlock or resume occurs. */
export async function confirmInterruptedBackup(deploymentId, { directory = PRODUCTION_OPERATION_DIRECTORY } = {}) {
  await operationDirectory(directory);
  const record = await lockRecord(join(directory, "operation.lock"));
  assert.equal(record.deploymentId, deploymentId, "PRODUCTION_OPERATION_TARGET_MISMATCH");
  assert.equal(record.kind, "backup", "PRODUCTION_OPERATION_CONFLICT");
  try { process.kill(record.pid, 0); }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
  throw new Error("PRODUCTION_OPERATION_STILL_RUNNING");
}
