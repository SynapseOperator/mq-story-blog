import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { readDeploymentManifest, readDeploymentFile, loadRuntimeEnvironment } from "../../scripts/production/runtime-config.mjs";
import { assertDatabaseUrl } from "../../scripts/production/database-config.mjs";
import { executeDeploymentAdminOperation } from "../../scripts/production/admin-cli.mjs";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeMediaVolume } from "../../scripts/production/init-media.mjs";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";
import { pauseDeploymentWriters, resumeDeploymentWriters } from "../../scripts/production/rotation.mjs";

// Test-only adapter, separate from the interactive administrator CLI. The
// harness owns a random Docker cluster; no existing host/development DB is used.
let pool, db, failed = false;
try {
  const config = await readDeploymentManifest(process.env.MQ_DEPLOYMENT_CONFIG);
  assert.equal(process.env.MQ_SYNTHETIC_LAB, "true");
  assert.equal(config.environment, "production");
  assert.equal(config.database.name, "mq_production");
  assert.equal(config.deploymentId, process.env.MQ_SYNTHETIC_DEPLOYMENT_ID);
  assert.equal(new URL(config.origin).hostname, "mq.localhost");
  const read = async name => (await readDeploymentFile(process.env[name], { secret: true })).trim();
  const action = process.argv[2];
  let result;
  if (action === "direct-request") {
    const response = await globalThis.fetch("http://app:3000/api/admin/stories", { headers: {
      origin: config.origin, "x-mq-proxy-key": "forged", "x-mq-client-ip": "127.0.0.1",
    } });
    result = { status: response.status };
  } else if (action === "disk-refusal") {
    await initializeMediaVolume(config);
    const store = await createLocalMediaStore({ projectRoot: process.cwd(), environment: config.environment,
      root: config.media.root, deploymentId: config.deploymentId, minimumFreeBytes: config.media.minFreeBytes,
      maxVariantBytes: 4 * 1024 * 1024 });
    await assert.rejects(store.write(randomUUID(), "display", Buffer.from("synthetic")), error => error.code === "LOW_DISK_SPACE");
    await assert.rejects(loadRuntimeEnvironment(process.env), /DEPLOYMENT_RUNTIME_CONFIG_REJECTED/);
    result = { minimumFreeBytes: config.media.minFreeBytes, diskRefused: true };
  } else {
    const identity = ["empty", "backup", "restore", "restored"].includes(action) ? "bootstrap" : "maintenance";
    const url = await read(`${identity.toUpperCase()}_DATABASE_URL_FILE`);
    assertDatabaseUrl(url, config, identity);
    pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
    pool.on("error", () => { failed = true; });
    if (action === "empty") {
      for (const table of ["User", "Story", "AdminGrant"]) {
        const sqlName = table === "Story" ? "story" : table;
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM public."${sqlName}"`)).rows[0].n, 0);
      }
      result = { users: 0, stories: 0, administratorGrants: 0 };
    } else if (["admin-init", "admin-revoke", "admin-restore"].includes(action)) {
      db = createAuthDatabaseClient(url);
      if (action === "admin-init") {
        const accounts = JSON.parse(await read("MQ_LAB_ACCOUNTS_FILE"));
        assert.match(accounts.admin.username, /^lab_admin_[a-f0-9]{8}$/);
        result = await executeDeploymentAdminOperation({ pool, db, config,
          input: { operation: "init", username: accounts.admin.username }, password: accounts.admin.password });
      } else {
        const grant = await db.adminGrant.findUniqueOrThrow({ where: { id: 1 }, select: { userId: true, version: true } });
        result = await executeDeploymentAdminOperation({ pool, db, config,
          input: { operation: action === "admin-revoke" ? "revoke" : "restore", userId: grant.userId, expectedVersion: grant.version } });
      }
    } else if (action === "backup") {
      const { initializeBackupRepository, backupDeployment } = await import("../../scripts/production/backup.mjs");
      const workspace = "/var/lib/mq/operations/work", repository = "/var/lib/mq/operations/repository";
      for (const path of [workspace, repository]) await mkdir(path, { mode: 0o700 });
      const options = { workspace, repository, passwordFile: process.env.RESTIC_PASSWORD_FILE };
      await initializeBackupRepository(options);
      await pauseDeploymentWriters(pool, config);
      const backup = await backupDeployment({ ...options, controlPool: pool, config,
        backupUrl: await read("BACKUP_DATABASE_URL_FILE"), receiptFile: "/var/lib/mq/operations/verified.json",
        sourceRevision: process.env.MQ_LAB_REVISION });
      await resumeDeploymentWriters(pool, config);
      const { manifest: _privateManifest, ...receipt } = backup;
      void _privateManifest;
      result = receipt;
    } else if (action === "restore") {
      const { restoreDeployment } = await import("../../scripts/production/restore.mjs");
      result = await restoreDeployment({ controlPool: pool, config, targetMigrationUrl: await read("MIGRATION_DATABASE_URL_FILE"),
        workspace: "/var/lib/mq/operations/work", repository: "/var/lib/mq/operations/repository", passwordFile: process.env.RESTIC_PASSWORD_FILE,
        snapshotId: process.env.MQ_BACKUP_SNAPSHOT_ID, confirmDeploymentId: config.deploymentId });
      await resumeDeploymentWriters(pool, config);
    } else if (action === "restored") {
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM public."Session"')).rows[0].n, 0);
      assert.equal((await pool.query("SELECT (SELECT count(*) FROM mq_publish_private.signing_key)+(SELECT count(*) FROM mq_comment_private.moderation_key) AS n")).rows[0].n, "0");
      for (const table of ["User", "story", "AdminGrant", "media_asset", "story_comment"])
        assert.ok((await pool.query(`SELECT count(*)::int AS n FROM public."${table}"`)).rows[0].n > 0);
      result = { dataRestored: true, sessions: 0, businessSigningKeys: 0 };
    } else throw new Error("FIXTURE_ACTION_REJECTED");
  }
  if (db) await db.$disconnect();
  if (pool) await pool.end();
  assert.equal(failed, false);
  console.log(JSON.stringify(result));
} catch {
  console.error("PRODUCTION_CONTRACT_FIXTURE_FAILED; private details withheld");
  process.exitCode = 1;
} finally {
  await Promise.allSettled([db?.$disconnect(), pool && !pool.ending ? pool.end() : undefined]);
}
