import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { readDeploymentManifest, readDeploymentFile } from "./runtime-config.mjs";
import { assertDatabaseUrl } from "./database-config.mjs";
import { pauseDeploymentWriters, resumeDeploymentWriters } from "./rotation.mjs";
import { auditRuntimeDatabase } from "./database.mjs";
import { ossLabBudget, ossLabRepository, OSS_LAB_CONFIRM } from "./oss-real-lab.mjs";

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
  const repository = process.env.MQ_LAB_S3_REPOSITORY || "/var/lib/mq/operations/repository";
  const workspace = "/var/lib/mq/operations/work", passwordFile = process.env.RESTIC_PASSWORD_FILE;
  const remote = Boolean(process.env.MQ_LAB_S3_REPOSITORY);
  const oss = process.env.MQ_LAB_REAL_OSS !== undefined;
  if (oss) {
    assert.equal(repository, ossLabRepository(process.env.MQ_LAB_OSS_SOURCE_ID, process.env.MQ_LAB_REAL_OSS));
    if (["backup", "oss-budget", "oss-snapshots"].includes(action)) assert.equal(config.deploymentId, process.env.MQ_LAB_OSS_SOURCE_ID);
  }
  const options = { repository, passwordFile, workspace, ...(remote ? { backend: "s3",
    s3: oss ? { region: "oss-cn-hongkong", credentialsFile: "/run/s3/s3_credentials" }
      : { region: "us-east-1", credentialsFile: "/run/s3/s3_credentials", caCertificateFile: "/etc/mq-s3/ca.crt" } } : {}) };
  // Restored targets have a new deployment identity but consume the original
  // repository. Its fixed source UUID is supplied separately for this lab only.
  if (remote && !["backup", "oss-budget"].includes(action)) options.expectedRepositoryId = (await readFile("/var/lib/mq/operations/repository-id", "utf8")).trim();
  let result;
  if (action === "oss-budget") {
    assert.ok(oss);
    const sizes = (await pool.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
      (SELECT COALESCE(sum(display_bytes+thumbnail_bytes),0)::text FROM public.media_asset WHERE state='READY') AS media_bytes`)).rows[0];
    result = { budget: ossLabBudget(Number(sizes.database_bytes), Number(sizes.media_bytes)) };
  } else if (action === "create-target") {
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
    await mkdir(workspace, { mode: 0o700, recursive: true });
    if (remote) {
      if (!oss) assert.match(repository, /^s3:https:\/\/mq-backup\.localhost\/mq-lab\/mq-p302-[a-f0-9]{32}$/);
      const { readS3CredentialsEnvironment, runBackupTool } = await import("./backup-tools.mjs");
      const env = { ...await readS3CredentialsEnvironment(options.s3.credentialsFile), GOMAXPROCS: "2" };
      const args = ["--repo", repository, "--password-file", passwordFile, "--no-cache", "-o", `s3.region=${options.s3.region}`,
        "-o", `s3.bucket-lookup=${oss ? "dns" : "path"}`, "-o", "s3.connections=2", "-o", "s3.retries=2",
        ...(!oss ? ["--cacert", options.s3.caCertificateFile] : [])];
      // Explicitly approved fresh synthetic prefix only. Host-side boto3 has
      // already required an empty prefix + config 404; init also refuses reuse.
      await runBackupTool("restic", [...args, "init", "--repository-version", "2"], { env });
      options.expectedRepositoryId = JSON.parse(await runBackupTool("restic", [...args, "cat", "config"], { env })).id;
      await writeFile("/var/lib/mq/operations/repository-id", options.expectedRepositoryId, { flag: "wx", mode: 0o600 });
    } else {
      await mkdir(repository, { mode: 0o700, recursive: true });
      await initializeBackupRepository(options);
    }
    const backupUrl = await secret("BACKUP_DATABASE_URL_FILE");
    const backupOptions = { ...options, controlPool: pool, backupUrl, config,
      receiptFile: "/var/lib/mq/operations/verified.json", sourceRevision: process.env.MQ_LAB_REVISION };
    await assert.rejects(backupDeployment(backupOptions));
    await pauseDeploymentWriters(pool, config);
    await pool.query(`GRANT UPDATE(id) ON public.story TO "${config.roles.backup}"`);
    await assert.rejects(backupDeployment(backupOptions));
    await pool.query(`REVOKE UPDATE(id) ON public.story FROM "${config.roles.backup}"`);
    result = await backupDeployment(backupOptions);
  } else if (action === "restore") {
    const { restoreDeployment } = await import("./restore.mjs");
    result = await restoreDeployment({ ...options, controlPool: pool, config, targetMigrationUrl: await secret("MIGRATION_DATABASE_URL_FILE"),
      snapshotId: process.env.MQ_BACKUP_SNAPSHOT_ID,
      confirmDeploymentId: config.deploymentId });
  } else if (action === "remote-negative") {
    assert.ok(remote);
    const { restic } = await import("./backup-tools.mjs");
    const { backupDeployment } = await import("./backup.mjs");
    await writeFile("/tmp/wrong-password", "wrong-synthetic-password-".repeat(3), { mode: 0o400 });
    await writeFile("/tmp/wrong-credentials", JSON.stringify({ accessKeyId: "synthetic-invalid", secretAccessKey: "synthetic-invalid" }), { mode: 0o400 });
    await writeFile("/tmp/wrong-ca", "not a certificate"); await chmod("/tmp/wrong-ca", 0o444);
    for (const invalid of [{ passwordFile: "/tmp/wrong-password" }, { expectedRepositoryId: "0".repeat(64) },
      { s3: { ...options.s3, credentialsFile: "/tmp/wrong-credentials" } }, { s3: { ...options.s3, caCertificateFile: "/tmp/wrong-ca" } }]) {
      await assert.rejects(restic(["check", "--read-data"], { ...options, ...invalid }));
    }
    await assert.rejects(backupDeployment({ ...options, expectedRepositoryId: "0".repeat(64), controlPool: pool,
      backupUrl: await secret("BACKUP_DATABASE_URL_FILE"), config,
      receiptFile: "/var/lib/mq/operations/failed.json", sourceRevision: process.env.MQ_LAB_REVISION }));
    await assert.rejects(access("/var/lib/mq/operations/failed.json"));
    result = { rejected: 5 };
  } else if (action === "retention") {
    const { retentionDryRun } = await import("./backup-tools.mjs");
    const plan = await retentionDryRun({ ...options, deploymentId: config.deploymentId });
    assert.equal(plan.deleted, 0); assert.equal(plan.dryRun, true);
    result = { noDeletion: true };
  } else if (action === "oss-snapshots") {
    assert.ok(oss); assert.equal(process.env.MQ_LAB_REAL_OSS, OSS_LAB_CONFIRM);
    const { readS3CredentialsEnvironment, runBackupTool } = await import("./backup-tools.mjs");
    const env = { ...await readS3CredentialsEnvironment(options.s3.credentialsFile), GOMAXPROCS: "2" };
    const snapshots = JSON.parse(await runBackupTool("restic", ["--repo", repository, "--password-file", passwordFile, "--no-cache",
      "-o", "s3.region=oss-cn-hongkong", "-o", "s3.bucket-lookup=dns", "-o", "s3.connections=2", "-o", "s3.retries=2",
      "snapshots", "--json"], { env }));
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].hostname, `mq-${config.deploymentId}`);
    assert.match(snapshots[0].id, /^[a-f0-9]{64}$/);
    result = { snapshots: snapshots.map(row => row.id), repositoryId: options.expectedRepositoryId };
  } else if (action === "oss-failure-receipt") {
    assert.ok(oss);
    await assert.rejects(access("/var/lib/mq/operations/failed-cli.json"), error => error.code === "ENOENT");
    result = { absentFailedReceipt: true };
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
    ...(action === "oss-budget" ? { budget: result.budget } : {}),
    ...(action === "oss-snapshots" ? { snapshots: result.snapshots, repositoryId: result.repositoryId } : {}),
    ...(oss && action === "backup" ? { databaseDumpBytes: result.manifest.database.byteLength,
      mediaBytes: result.manifest.inventory.filter(row => row.state === "READY").reduce((sum, row) => sum + row.display_bytes + row.thumbnail_bytes, 0) } : {}),
    ...(action === "receipt" ? { verified: result.verified, deploymentId: result.deploymentId, completedAt: result.completedAt,
      backend: result.backend, ...(result.repositoryId ? { repositoryId: result.repositoryId } : {}) } : {}) }));
} catch (error) {
  const phase = /^[a-z-]{1,48}$/.test(error.phase ?? "") ? ` phase=${error.phase}` : "";
  console.error(`OPERATIONS_LAB_ACTION_FAILED${phase}`); process.exitCode = 1;
}
finally { if (pool && !pool.ending) await pool.end(); }
