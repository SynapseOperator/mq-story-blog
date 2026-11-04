import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";
import { compareRestoredInventory, verifyMediaBackup } from "./backup.mjs";
import { backupError, createPrivateChild, verifyPrivateFile, writePrivate } from "./backup-files.mjs";
import { localBackupTarget, runPgBackupTool } from "./backup-pg.mjs";
import { configureTemporaryDatabaseLogging } from "../db/log-privacy.mjs";

/** First release is a restore drill only: CREATE a random isolated database and
 * private directory; never overwrite a target or automatically start a service.
 * Source archive is trusted operator input, not an HTTP upload. */
export async function restoreMediaBackup({ directory, controlURL, restoreParent, projectRoot, tools = {} }) {
  let target;
  try { target = localBackupTarget(controlURL, "mq_test"); }
  catch { throw backupError("RESTORE_TARGET_REJECTED"); }
  if (target.username !== "mq_test") throw backupError("RESTORE_TARGET_REJECTED");
  const manifest = await verifyMediaBackup(directory);
  const name = `mq_test_admin_${randomUUID().replaceAll("-", "")}`;
  const control = new pg.Pool({ connectionString: controlURL, max: 1, connectionTimeoutMillis: 5000 });
  let pool, privateRoot, created = false;
  const restored = new URL(controlURL); restored.pathname = `/${name}`;
  try {
    if ((await control.query("SELECT current_database() AS db,current_user AS actor")).rows[0].actor !== "mq_test") throw backupError("RESTORE_TARGET_REJECTED");
    await control.query(`CREATE DATABASE "${name}"`); created = true;
    await configureTemporaryDatabaseLogging(control, name);
    await control.query(`REVOKE CONNECT,TEMPORARY ON DATABASE "${name}" FROM PUBLIC`);
    privateRoot = await createPrivateChild(restoreParent, "mq-restored-media-");
    await runPgBackupTool("pg_restore", ["--exit-on-error", "--single-transaction", "--no-owner", "--no-acl"], restored,
      { ...tools, input: join(directory, "database.dump") });
    pool = new pg.Pool({ connectionString: restored.href, max: 1, connectionTimeoutMillis: 5000 });
    // --no-acl intentionally avoids reviving old deployment identities. Default
    // PUBLIC EXECUTE must be removed before this drill may grant any app access.
    await pool.query("REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC; REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const rows = await compareRestoredInventory(pool, manifest);
    const store = await createLocalMediaStore({ projectRoot, roots: { development: join(restoreParent, `unused-${randomUUID()}`), test: privateRoot },
      environment: "test", maxVariantBytes: 4 * 1024 * 1024 });
    for (const row of rows) for (const variant of ["display", "thumbnail"]) {
      const bytes = await verifyPrivateFile(join(directory, "media", row.storage_key, `${variant}.webp`), 4 * 1024 * 1024);
      await store.write(row.storage_key, variant, bytes);
    }
    await writePrivate(join(privateRoot, "RESTORE_COMPLETE.json"), Buffer.from(JSON.stringify({ format: "mq-restore-drill-v1", database: name,
      files: rows.length * 2, serviceEnabled: false, privilegesRequireProvisioning: true })));
    return { database: name, databaseURL: restored.href, privateRoot, files: rows.length * 2 };
  } catch {
    // A partial private directory is retained for diagnosis, never labeled complete.
    await pool?.end(); pool = undefined;
    if (created) await control.query(`DROP DATABASE "${name}"`).catch(() => {});
    throw backupError("RESTORE_FAILED");
  } finally { await pool?.end(); await control.end(); }
}
