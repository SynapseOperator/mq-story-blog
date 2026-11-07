import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import pg from "pg";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";
import { createPrivateChild, digest, privatePath, writePrivate, uuid } from "../media/backup-files.mjs";
import { fileDigest, mediaInventorySql, verifyMediaBackup } from "../media/backup.mjs";
import { assertDatabaseUrl, deploymentDatabaseTag } from "./database-config.mjs";
import { verifyDeploymentMigrations } from "./database.mjs";
import { assertMaintenanceControl, assertWritersPaused, MAINTENANCE_LOCK } from "./rotation.mjs";
import { assertBackupPaths, backupBackend, containsPath, requireBackupSpace, runBackupTool, pgToolEnvironment, restic } from "./backup-tools.mjs";

export { initializeBackupRepository } from "./backup-tools.mjs";

async function writeBackupReceipt(path, receipt) {
  const temporary = join(dirname(path), `.mq-receipt-${randomUUID()}`);
  // Publish only a fully written/fsynced receipt. Hard-link creation refuses an
  // existing final name, unlike rename which may replace another attempt.
  await writePrivate(temporary, Buffer.from(JSON.stringify(receipt)));
  try { await link(temporary, path); }
  finally { await unlink(temporary); }
}

/** Only remove a child created by this module, never a caller-supplied root. */
export async function removeBackupWorkChild(directory, workspace) {
  assert.equal(dirname(resolve(directory)), resolve(workspace));
  assert.match(basename(directory), /^mq-(?:export|verify)-[a-f0-9-]{36}$/);
  await privatePath(directory);
  await rm(directory, { recursive: true });
}

/** Every extracted snapshot is fully authenticated by Restic and then checked
 * against the independent database/file inventory. Only explicit snapshot IDs. */
export async function restoreSnapshot({ repository, passwordFile, snapshotId, workspace, backend = "local", s3, expectedRepositoryId }) {
  const options = { repository, passwordFile, workspace, backend, s3, expectedRepositoryId };
  assert.match(snapshotId ?? "", /^[a-f0-9]{64}$/);
  await assertBackupPaths(options);
  await restic(["check", "--read-data"], options);
  const directory = await createPrivateChild(workspace, "mq-verify-");
  await restic(["restore", `${snapshotId}:/payload`, "--target", directory, "--verify"], options);
  const manifest = await verifyMediaBackup(directory);
  assert.equal(manifest.deployment?.format, "mq-deployment-backup-v1");
  assert.match(manifest.deployment.id ?? "", uuid);
  assert.match(manifest.deployment.revision ?? "", /^[a-f0-9]{40}$/);
  return { directory, manifest };
}

/** Cold maintenance backup: all four writer roles must be NOLOGIN and fully
 * drained. The shared maintenance lock prevents resume/key rotation while the
 * snapshot is copied. No application/admin transaction is held across I/O. */
export async function backupDeployment({ controlPool, backupUrl, config, workspace, repository, passwordFile, receiptFile, sourceRevision,
  backend = "local", s3, expectedRepositoryId }) {
  const options = { workspace, repository, passwordFile, backend, s3, expectedRepositoryId };
  backupBackend(options);
  const target = assertDatabaseUrl(backupUrl, config, "backup");
  assert.match(sourceRevision ?? "", /^[a-f0-9]{40}$/);
  await assertBackupPaths(options);
  await privatePath(dirname(receiptFile));
  assert.ok(!containsPath(process.cwd(), receiptFile), "BACKUP_PATH_IN_APPLICATION");
  assert.ok(!containsPath(config.media.root, workspace) && !containsPath(workspace, config.media.root), "BACKUP_PATH_OVERLAP");
  if (backend === "local") assert.ok(!containsPath(repository, receiptFile), "BACKUP_PATH_OVERLAP");
  // Receipts are unique per attempt. An existing success receipt is never
  // overwritten or re-used to suggest that a failed new attempt succeeded.
  assert.ok(!(await readdir(dirname(receiptFile))).includes(basename(receiptFile)), "BACKUP_RECEIPT_EXISTS");
  const control = await controlPool.connect(); let held = false, snapshotClient, phase = "target";
  const pool = new pg.Pool({ connectionString: backupUrl, max: 1, connectionTimeoutMillis: 5000 });
  let failed = false; pool.on("error", () => { failed = true; });
  try {
    await assertMaintenanceControl(control, config);
    held = (await control.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held", [MAINTENANCE_LOCK])).rows[0].held;
    assert.ok(held, "BACKUP_MAINTENANCE_BUSY");
    await assertWritersPaused(control, config);
    phase = "snapshot";
    snapshotClient = await pool.connect();
    const identity = (await snapshotClient.query(`SELECT current_user AS actor,current_database() AS db,
      shobj_description(d.oid,'pg_database') AS tag,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
    assert.equal(identity.actor, config.roles.backup); assert.equal(identity.db, config.database.name);
    assert.equal(identity.tag, deploymentDatabaseTag(config));
    assert.ok(!identity.rolsuper && !identity.rolcreatedb && !identity.rolcreaterole && !identity.rolbypassrls);
    const unsafe = (await snapshotClient.query(`SELECT
      has_database_privilege(current_database(),'CREATE,TEMP') OR
      EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('public','mq_publish_private','mq_comment_private') AND has_schema_privilege(oid,'CREATE')) OR
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','mq_publish_private','mq_comment_private') AND c.relkind='r'
        AND (has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(c.oid,'INSERT,UPDATE'))) OR
      EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'mq_%' AND has_function_privilege(p.oid,'EXECUTE')) AS unsafe`)).rows[0].unsafe;
    assert.equal(unsafe, false, "BACKUP_IDENTITY_PRIVILEGE_REJECTED");
    await verifyDeploymentMigrations(snapshotClient);
    await snapshotClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const inventory = (await snapshotClient.query(mediaInventorySql)).rows;
    assert.ok(inventory.length <= 10000 && inventory.every(row => ["READY", "FAILED", "DELETED"].includes(row.state)), "BACKUP_TRANSITION_BUSY");
    const ready = inventory.filter(row => row.state === "READY");
    const databaseSize = Number((await snapshotClient.query("SELECT pg_database_size(current_database()) AS bytes")).rows[0].bytes);
    const mediaBytes = ready.reduce((sum, row) => sum + row.display_bytes + row.thumbnail_bytes, 0);
    // Work payload plus independent restore verification; reserve room in the
    // encrypted repo too. This is admission control, not a filesystem quota.
    // Conservative 3x admission also covers repo/workspace on the same disk:
    // export + authenticated re-extraction + an incompressible encrypted copy.
    await requireBackupSpace(workspace, 3 * (databaseSize + mediaBytes));
    if (backend === "local") await requireBackupSpace(repository, 3 * (databaseSize + mediaBytes));
    const child = await createPrivateChild(workspace, "mq-export-"), directory = join(child, "payload");
    await mkdir(directory, { mode: 0o700 }); await mkdir(join(directory, "media"), { mode: 0o700 });
    const store = await createLocalMediaStore({ projectRoot: process.cwd(), environment: config.environment,
      root: config.media.root, deploymentId: config.deploymentId, minimumFreeBytes: config.media.minFreeBytes, maxVariantBytes: 4 * 1024 * 1024 });
    phase = "media-copy";
    for (const row of ready) {
      assert.match(row.id, uuid); assert.match(row.storage_key, uuid);
      await mkdir(join(directory, "media", row.storage_key), { mode: 0o700 });
      for (const variant of ["display", "thumbnail"]) {
        const bytes = await store.read(row.storage_key, variant);
        assert.equal(bytes.length, row[`${variant}_bytes`]); assert.equal(digest(bytes), row[`${variant}_sha256`]);
        await writePrivate(join(directory, "media", row.storage_key, `${variant}.webp`), bytes);
      }
    }
    const snapshot = (await snapshotClient.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    const dump = join(directory, "database.dump");
    phase = "database-dump";
    await runBackupTool("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--snapshot=${snapshot}`], { env: pgToolEnvironment(target), output: dump });
    const database = await fileDigest(dump); assert.ok(database.byteLength);
    const manifest = { format: "mq-private-backup-v1", postgresMajor: 18, createdAt: new Date().toISOString(), sourceDatabase: config.database.name,
      database, inventory, files: ready.length * 2, deployment: { format: "mq-deployment-backup-v1", id: config.deploymentId,
        environment: config.environment, revision: sourceRevision, migrations: 8, restic: "0.19.1" } };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    await writePrivate(join(directory, "manifest.json"), manifestBytes);
    await snapshotClient.query("COMMIT");
    await writePrivate(join(directory, "COMPLETE.json"), Buffer.from(JSON.stringify({ format: manifest.format,
      manifestSha256: digest(manifestBytes), databaseSha256: database.sha256 })));
    await verifyMediaBackup(directory);
    phase = "encryption";
    const output = await restic(["backup", "--json", "--host", `mq-${config.deploymentId}`, "--tag", "mq-deployment-v1", "payload"], { ...options, cwd: child });
    const summary = output.trim().split("\n").map(line => JSON.parse(line)).find(row => row.message_type === "summary");
    const snapshotId = summary?.snapshot_id; assert.match(snapshotId ?? "", /^[a-f0-9]{64}$/);
    phase = "repository-verification";
    const verified = await restoreSnapshot({ ...options, snapshotId });
    await assertWritersPaused(control, config);
    assert.equal(failed, false);
    // The durable copy is encrypted. Remove only this attempt's verified,
    // private plaintext children; failures retain incomplete work for review.
    phase = "plaintext-cleanup";
    await removeBackupWorkChild(verified.directory, workspace);
    await removeBackupWorkChild(child, workspace);
    const receipt = { verified: true, snapshotId, completedAt: new Date().toISOString(), sourceRevision,
      deploymentId: config.deploymentId, assets: ready.length, files: ready.length * 2, backend,
      ...(expectedRepositoryId ? { repositoryId: expectedRepositoryId } : {}) };
    phase = "receipt";
    await writeBackupReceipt(receiptFile, receipt);
    return { ...receipt, manifest };
  } catch { if (snapshotClient) await snapshotClient.query("ROLLBACK").catch(() => {}); throw Object.assign(new Error("DEPLOYMENT_BACKUP_FAILED"), { phase }); }
  finally {
    snapshotClient?.release(); await pool.end();
    try { if (held) await control.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [MAINTENANCE_LOCK]); }
    finally { control.release(); }
  }
}
