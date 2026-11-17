import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { validateDeploymentConfig, deploymentDatabaseTag } from "../production/database-config.mjs";
import { bootstrapDeploymentDatabase, migrateDeploymentDatabase, provisionDeploymentDatabase, initializeDeploymentSigningKeys, auditRuntimeDatabase } from "../production/database.mjs";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin } from "../../src/server/admin/maintenance.ts";
import { verifyMaintenanceConnection } from "../admin/maintenance-policy.mjs";

let stage = "configuration";
try {
  const saved = JSON.parse(await readFile("/run/mq-demo/setup/config.json", "utf8"));
  const secrets = JSON.parse(await readFile("/run/mq-demo/setup/credentials.json", "utf8"));
  const config = validateDeploymentConfig({ version: 1, environment: "staging", deploymentId: saved.deploymentId, database: saved.database });
  const pool = new pg.Pool({ connectionString: secrets.bootstrap, max: 1 });
  try {
    stage = "database-identity";
    const tag = (await pool.query("SELECT shobj_description(oid,'pg_database') AS tag FROM pg_database WHERE datname=current_database()")).rows[0].tag;
    if (tag === null) await bootstrapDeploymentDatabase(pool, config, secrets.rolePasswords);
    else assert.equal(tag, deploymentDatabaseTag(config));
    stage = "migration"; await migrateDeploymentDatabase(secrets.migration, config);
    stage = "permissions"; await provisionDeploymentDatabase(pool, config);
    stage = "signing-keys";
    const keys = await pool.query("SELECT (SELECT count(*) FROM mq_publish_private.signing_key) AS publication, (SELECT count(*) FROM mq_comment_private.moderation_key) AS moderation");
    if (keys.rows[0].publication === "0" && keys.rows[0].moderation === "0") {
      await initializeDeploymentSigningKeys(pool, config, { publication: secrets.runtime.MQ_PUBLISH_SIGNING_KEY, moderation: secrets.runtime.MQ_COMMENT_SIGNING_KEY });
    } else {
      assert.equal((await pool.query("SELECT (SELECT secret=$1 FROM mq_publish_private.signing_key WHERE id=1) AND (SELECT secret=$2 FROM mq_comment_private.moderation_key WHERE id=1) AS valid",
        [Buffer.from(secrets.runtime.MQ_PUBLISH_SIGNING_KEY, "hex"), Buffer.from(secrets.runtime.MQ_COMMENT_SIGNING_KEY, "hex")])).rows[0].valid, true);
    }
  } finally { await pool.end(); }
  stage = "runtime-audit";
  const runtime = new pg.Pool({ connectionString: secrets.runtime.DATABASE_URL, max: 1 });
  try { await auditRuntimeDatabase(runtime, config); } finally { await runtime.end(); }
  stage = "administrator";
  const maintenance = new pg.Pool({ connectionString: secrets.maintenance, max: 1 });
  try { await verifyMaintenanceConnection(maintenance, config.database.name); } finally { await maintenance.end(); }
  const client = createAuthDatabaseClient(secrets.maintenance);
  try {
    const grant = await client.adminGrant.findUnique({ where: { id: 1 } });
    if (!grant) await initializeAdmin(client, secrets.admin);
    // Repeat starts never reset the admin's password, grant or application data.
  } finally { await client.$disconnect(); }
  await writeFile("/run/mq-demo/setup/initialized", "1", { mode: 0o600 });
  console.log("DEMO_DATABASE_READY: PostgreSQL 18, migrations, five login roles and eleven function owners verified");
} catch { console.error(`DEMO_INITIALIZE_FAILED: ${stage}; database and secret volumes retained`); process.exitCode = 1; }
