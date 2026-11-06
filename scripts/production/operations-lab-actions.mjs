import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { readDeploymentManifest, readDeploymentFile } from "./runtime-config.mjs";
import { assertDatabaseUrl } from "./database-config.mjs";
import { pauseDeploymentWriters, resumeDeploymentWriters } from "./rotation.mjs";
import { auditRuntimeDatabase } from "./database.mjs";

// Disposable-container-only test adapter. Never accepts production, real
// deployment names or arbitrary SQL. No secrets enter its result JSON.
let pool, failed = false;
try {
  const config = await readDeploymentManifest(process.env.MQ_DEPLOYMENT_CONFIG);
  assert.equal(process.env.MQ_SYNTHETIC_LAB, "true");
  assert.equal(config.environment, "staging");
  assert.match(config.database.name, /^mq_staging_[a-f0-9]{32}$/);
  const secret = async name => (await readDeploymentFile(process.env[name], { secret: true })).trim();
  const controlUrl = await secret("BOOTSTRAP_DATABASE_URL_FILE");
  assertDatabaseUrl(controlUrl, config, "bootstrap");
  pool = new pg.Pool({ connectionString: controlUrl, max: 1, connectionTimeoutMillis: 5000 });
  pool.on("error", () => { failed = true; });
  const action = process.argv[2];
  let result;
  if (action === "create-target") {
    // Cluster administrator creates only this lab's fresh database. Never
    // DROP/TRUNCATE/reuse an existing database, even on test failure.
    const name = config.database.name;
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_database WHERE datname=$1", [name])).rows[0].n, 1);
    const target = await readDeploymentManifest(process.env.MQ_RESTORE_CONFIG);
    assert.equal(target.environment, "staging");
    assert.match(target.database.name, /^mq_staging_[a-f0-9]{32}$/);
    assert.notEqual(target.deploymentId, config.deploymentId);
    assert.notEqual(target.database.name, name);
    assert.equal(target.database.host, config.database.host);
    assert.equal(target.database.port, config.database.port);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_database WHERE datname=$1", [target.database.name])).rows[0].n, 0);
    await pool.query(`CREATE DATABASE "${target.database.name}"`);
    result = { createdIsolatedTarget: true };
  } else if (action === "backup") {
    const { backupDeployment, initializeBackupRepository } = await import("./backup.mjs");
    const workspace = "/var/lib/mq/operations/work", repository = "/var/lib/mq/operations/repository";
    await mkdir(workspace, { mode: 0o700, recursive: true });
    await mkdir(repository, { mode: 0o700, recursive: true });
    const passwordFile = process.env.RESTIC_PASSWORD_FILE;
    await initializeBackupRepository({ repository, passwordFile });
    const backupUrl = await secret("BACKUP_DATABASE_URL_FILE");
    const backupOptions = { controlPool: pool, backupUrl, config, workspace, repository, passwordFile,
      receiptFile: "/var/lib/mq/operations/verified.json", sourceRevision: process.env.MQ_LAB_REVISION };
    await assert.rejects(backupDeployment(backupOptions));
    await pauseDeploymentWriters(pool, config);
    await pool.query(`GRANT UPDATE(id) ON public.story TO "${config.roles.backup}"`);
    await assert.rejects(backupDeployment(backupOptions));
    await pool.query(`REVOKE UPDATE(id) ON public.story FROM "${config.roles.backup}"`);
    result = await backupDeployment(backupOptions);
  } else if (action === "restore") {
    const { restoreDeployment } = await import("./restore.mjs");
    result = await restoreDeployment({ controlPool: pool, config, targetMigrationUrl: await secret("MIGRATION_DATABASE_URL_FILE"),
      workspace: "/var/lib/mq/operations/work", repository: "/var/lib/mq/operations/repository",
      passwordFile: process.env.RESTIC_PASSWORD_FILE, snapshotId: process.env.MQ_BACKUP_SNAPSHOT_ID,
      confirmDeploymentId: config.deploymentId });
  } else if (action === "assert-restored") {
    const sessions = (await pool.query('SELECT count(*)::int AS n FROM public."Session"')).rows[0].n;
    const keys = (await pool.query("SELECT (SELECT count(*) FROM mq_publish_private.signing_key)+(SELECT count(*) FROM mq_comment_private.moderation_key) AS n")).rows[0].n;
    assert.equal(sessions, 0); assert.equal(keys, "0");
    for (const [table, minimum] of [["User", 2], ["story", 2], ["media_asset", 2], ["story_revision_asset", 2], ["story_comment", 1], ["AdminGrant", 1]]) {
      assert.ok((await pool.query(`SELECT count(*)::int AS n FROM public."${table}"`)).rows[0].n >= minimum);
    }
    const constraints = (await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN ('c','f','u')")).rows[0].n;
    assert.ok(constraints >= 30);
    const url = await secret("RUNTIME_DATABASE_URL_FILE");
    assertDatabaseUrl(url, config);
    const runtime = new pg.Pool({ connectionString: url, max: 1 }); runtime.on("error", () => { failed = true; });
    try {
      await auditRuntimeDatabase(runtime, config);
      for (const sql of ['UPDATE public.story SET state=\'PUBLISHED\'', 'DELETE FROM public."AdminGrant"', 'SELECT * FROM mq_publish_private.signing_key']) {
        await assert.rejects(runtime.query(sql), error => error.code === "42501");
      }
      await assert.rejects(runtime.query('INSERT INTO public.story_like (story_id,user_id) VALUES ($1,$2)', [randomUUID(), "absent"]), error => error.code === "23503");
    } finally { await runtime.end(); }
    result = { sessionsCleared: true, signingKeysCleared: true, usersAndStoriesPreserved: true, constraintsAndLeastPrivilege: true };
  } else if (action === "assert-credentials") {
    const old = JSON.parse(await secret("MQ_OLD_ROLE_PASSWORDS_FILE")), current = JSON.parse(await secret("MQ_NEW_ROLE_PASSWORDS_FILE"));
    for (const name of Object.keys(current)) {
      const url = new URL(controlUrl); url.username = config.roles[name]; url.password = old[name];
      const previous = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
      await assert.rejects(previous.connect(), error => error.code === "28P01"); await previous.end();
      url.password = current[name]; const next = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
      await next.connect(); await next.query("SELECT 1"); await next.end();
    }
    result = { oldPasswordsRejected: 5, newPasswordsAccepted: 5, authentication: "SCRAM" };
  } else if (action === "resume") {
    result = await resumeDeploymentWriters(pool, config);
  } else if (action === "receipt") {
    result = JSON.parse(await readFile("/var/lib/mq/operations/verified.json", "utf8"));
  } else throw new Error();
  await pool.end(); if (failed) throw new Error();
  // Whitelist outputs: a backup manifest contains private storage keys. Never
  // print it, even in this synthetic environment.
  console.log(JSON.stringify({ action, ok: true,
    ...(result?.snapshotId ? { snapshotId: result.snapshotId } : {}),
    ...(action === "receipt" ? { verified: result.verified, deploymentId: result.deploymentId, completedAt: result.completedAt } : {}) }));
} catch (error) {
  const phase = /^[a-z-]{1,48}$/.test(error.phase ?? "") ? ` phase=${error.phase}` : "";
  console.error(`OPERATIONS_LAB_ACTION_FAILED${phase}`); process.exitCode = 1;
}
finally { if (pool && !pool.ending) await pool.end(); }
