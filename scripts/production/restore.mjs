import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";
import { compareRestoredInventory } from "../media/backup.mjs";
import { privatePath, verifyPrivateFile } from "../media/backup-files.mjs";
import { assertDatabaseUrl } from "./database-config.mjs";
import { verifyDeploymentMigrations } from "./database.mjs";
import { initializeMediaVolume } from "./init-media.mjs";
import { assertMaintenanceControl, MAINTENANCE_LOCK, WRITER_IDENTITIES } from "./rotation.mjs";
import { removeBackupWorkChild, restoreSnapshot } from "./backup.mjs";
import { backupBackend, containsPath, pgToolEnvironment, requireBackupSpace, runBackupTool } from "./backup-tools.mjs";

const quote = value => `"${value.replaceAll('"', '""')}"`;

/** Restore only into a separately bootstrapped EMPTY deployment. Never DROP,
 * --clean, overwrite or reuse existing tables/media. The imported SQL runs as
 * the constrained migration identity, not the offline superuser. A failure
 * retains an isolated, paused target for diagnosis; there is no auto-resume. */
export async function restoreDeployment({ controlPool, config, targetMigrationUrl, workspace, repository, passwordFile,
  snapshotId, confirmDeploymentId, backend = "local", s3, expectedRepositoryId }) {
  const options = { repository, passwordFile, workspace, backend, s3, expectedRepositoryId };
  backupBackend(options);
  assert.equal(confirmDeploymentId, config.deploymentId, "RESTORE_CONFIRMATION_REJECTED");
  const target = assertDatabaseUrl(targetMigrationUrl, config, "migration");
  await privatePath(config.media.root);
  assert.deepEqual(await readdir(config.media.root), [], "RESTORE_MEDIA_NOT_EMPTY");
  assert.ok(!containsPath(workspace, config.media.root) && !containsPath(config.media.root, workspace), "RESTORE_PATH_OVERLAP");
  if (backend === "local") assert.ok(!containsPath(repository, config.media.root) && !containsPath(config.media.root, repository), "RESTORE_PATH_OVERLAP");
  const { directory, manifest } = await restoreSnapshot({ ...options, snapshotId });
  assert.notEqual(manifest.deployment.id, config.deploymentId, "RESTORE_SOURCE_TARGET_REUSE");
  // Production uses the same fixed database name on a replacement server.
  // A fresh deployment ID/tag plus the empty-object checks establish isolation;
  // comparing names would incorrectly reject valid disaster recovery.
  await requireBackupSpace(config.media.root, manifest.inventory.filter(row => row.state === "READY")
    .reduce((sum, row) => sum + row.display_bytes + row.thumbnail_bytes, 0));
  const control = await controlPool.connect(); let held = false, phase = "target";
  try {
    await assertMaintenanceControl(control, config);
    held = (await control.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held", [MAINTENANCE_LOCK])).rows[0].held;
    assert.ok(held, "RESTORE_MAINTENANCE_BUSY");
    const empty = (await control.query(`SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') +
      (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')) +
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') +
      (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql') AS n`)).rows[0].n;
    assert.equal(empty, "0", "RESTORE_DATABASE_NOT_EMPTY");
    // Close all writers before temporarily admitting the sole restore identity.
    // Existing connections refuse recovery rather than being force-terminated.
    for (const key of WRITER_IDENTITIES) await control.query(`ALTER ROLE ${quote(config.roles[key])} NOLOGIN`);
    assert.equal((await control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=ANY($1)",
      [WRITER_IDENTITIES.map(key => config.roles[key])])).rows[0].n, 0, "RESTORE_WRITERS_NOT_DRAINED");
    await initializeMediaVolume(config);
    phase = "database-restore";
    await control.query(`ALTER ROLE ${quote(config.roles.migration)} LOGIN`);
    try {
      await runBackupTool("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-acl", "--dbname", config.database.name],
        { env: pgToolEnvironment(target), input: join(directory, "database.dump") });
    } finally { await control.query(`ALTER ROLE ${quote(config.roles.migration)} NOLOGIN`); }
    // Default-deny BEFORE any runtime grants or app start. Source cookies and
    // captured HMAC proofs cannot regain validity if old app files are reused.
    phase = "permissions-and-revocation";
    await control.query("BEGIN");
    try {
      for (const schema of ["public", "mq_publish_private", "mq_comment_private"]) {
        await control.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC;
          REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC;
          REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC;
          REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      }
      await control.query('DELETE FROM public."Session"');
      await control.query("DELETE FROM mq_publish_private.signing_key; DELETE FROM mq_comment_private.moderation_key");
      await control.query("COMMIT");
    } catch (error) { await control.query("ROLLBACK"); throw error; }
    phase = "database-verification";
    await verifyDeploymentMigrations(control);
    const rows = await compareRestoredInventory(control, manifest);
    const store = await createLocalMediaStore({ projectRoot: process.cwd(), environment: config.environment,
      root: config.media.root, deploymentId: config.deploymentId, minimumFreeBytes: config.media.minFreeBytes, maxVariantBytes: 4 * 1024 * 1024 });
    phase = "media-restore";
    for (const row of rows) for (const variant of ["display", "thumbnail"]) {
      const bytes = await verifyPrivateFile(join(directory, "media", row.storage_key, `${variant}.webp`), 4 * 1024 * 1024);
      await store.write(row.storage_key, variant, bytes);
      assert.deepEqual(await store.read(row.storage_key, variant), bytes);
    }
    phase = "plaintext-cleanup";
    await removeBackupWorkChild(directory, workspace);
    return { restored: true, snapshotId, sourceDeploymentId: manifest.deployment.id, deploymentId: config.deploymentId,
      migrations: 10, assets: rows.length, files: rows.length * 2, sessionsRevoked: true, signingKeysRemoved: true,
      writersRemainPaused: true, privilegesRequireProvisioning: true, serviceEnabled: false };
  } catch { throw Object.assign(new Error("DEPLOYMENT_RESTORE_FAILED"), { phase }); }
  finally {
    try { if (held) await control.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [MAINTENANCE_LOCK]); }
    finally { control.release(); }
  }
}

/** Utility for callers that need a bounded, safely logged control pool. */
export function createBackupControlPool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  let failed = false;
  pool.on("error", () => { failed = true; });
  return { pool, assertHealthy() { assert.equal(failed, false, "DEPLOYMENT_BACKUP_CONNECTION_FAILED"); } };
}
