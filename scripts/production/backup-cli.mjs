import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readDeploymentFile, readDeploymentManifest } from "./runtime-config.mjs";
import { assertDatabaseUrl } from "./database-config.mjs";
import { initializeBackupRepository, backupDeployment, removeBackupWorkChild, restoreSnapshot } from "./backup.mjs";
import { createBackupControlPool, restoreDeployment } from "./restore.mjs";

export async function runBackupCommand(action, args, env = process.env) {
  assert.ok(["init", "backup", "verify", "restore"].includes(action));
  const config = await readDeploymentManifest(env.MQ_DEPLOYMENT_CONFIG);
  assert.equal(env.MQ_DEPLOYMENT_ENV, config.environment);
  assert.deepEqual(args, [`--confirm-deployment=${config.deploymentId}`]);
  for (const name of ["BOOTSTRAP_DATABASE_URL", "BACKUP_DATABASE_URL", "RESTORE_MIGRATION_DATABASE_URL", "RESTIC_PASSWORD", "RESTIC_REPOSITORY", "RESTIC_PASSWORD_COMMAND"])
    assert.ok(!Object.hasOwn(env, name), "BACKUP_INLINE_SECRET_REJECTED");
  const options = { repository: env.MQ_BACKUP_REPOSITORY, passwordFile: env.MQ_BACKUP_PASSWORD_FILE,
    workspace: env.MQ_BACKUP_WORKSPACE };
  if (action === "init") return initializeBackupRepository(options);
  if (action === "verify") {
    const { manifest, directory } = await restoreSnapshot({ ...options, snapshotId: env.MQ_BACKUP_SNAPSHOT });
    assert.equal(manifest.deployment.id, config.deploymentId, "BACKUP_SOURCE_DEPLOYMENT_MISMATCH");
    await removeBackupWorkChild(directory, options.workspace);
    return { verified: true, snapshotId: env.MQ_BACKUP_SNAPSHOT, deploymentId: manifest.deployment.id, files: manifest.files };
  }
  const bootstrap = (await readDeploymentFile(env.BOOTSTRAP_DATABASE_URL_FILE, { secret: true })).trim();
  assertDatabaseUrl(bootstrap, config, "bootstrap");
  const control = createBackupControlPool(bootstrap);
  try {
    let result;
    if (action === "backup") {
      const backupUrl = (await readDeploymentFile(env.BACKUP_DATABASE_URL_FILE, { secret: true })).trim();
      const receipt = await backupDeployment({ ...options, controlPool: control.pool, config, backupUrl,
        receiptFile: env.MQ_BACKUP_RECEIPT, sourceRevision: env.MQ_BACKUP_SOURCE_REVISION });
      result = { verified: receipt.verified, snapshotId: receipt.snapshotId, completedAt: receipt.completedAt,
        deploymentId: receipt.deploymentId, sourceRevision: receipt.sourceRevision, assets: receipt.assets, files: receipt.files };
    } else {
      const targetMigrationUrl = (await readDeploymentFile(env.RESTORE_MIGRATION_DATABASE_URL_FILE, { secret: true })).trim();
      result = await restoreDeployment({ ...options, controlPool: control.pool, config, targetMigrationUrl,
        snapshotId: env.MQ_BACKUP_SNAPSHOT, confirmDeploymentId: config.deploymentId });
    }
    await control.pool.end(); control.assertHealthy();
    return result;
  } finally { if (!control.pool.ending) await control.pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await runBackupCommand(process.argv[2], process.argv.slice(3)))); }
  catch (error) {
    const phases = ["target", "snapshot", "media-copy", "database-dump", "encryption", "repository-verification", "plaintext-cleanup", "receipt",
      "database-restore", "permissions-and-revocation", "database-verification", "media-restore"];
    console.error("DEPLOYMENT_BACKUP_OPERATION_REJECTED", phases.includes(error.phase) ? error.phase : "configuration-or-verification");
    process.exitCode = 1;
  }
}
