import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, URL } from "node:url";
import pg from "pg";
import { databaseUrl } from "../db/environment.mjs";
import { logPrivacySettings } from "../db/log-privacy.mjs";
import { LOGIN_IDENTITIES, validateDeploymentConfig } from "./database-config.mjs";
import { bootstrapDeploymentDatabase, migrateDeploymentDatabase, provisionDeploymentDatabase } from "./database.mjs";
import { executeDeploymentAdminOperation, verifyDeploymentAdminConnection } from "./admin-cli.mjs";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { verifyPassword } from "../../src/server/auth/password.ts";

// The existing test-service guard is mandatory; this never targets the shared
// development database or a production name. The container rehearsal exercises
// the production manifest separately with an entirely isolated PG instance.
export async function runDeploymentAdminTests() {
  const base = new URL(await databaseUrl("test")), id = randomUUID(), name = `mq_staging_${id.replaceAll("-", "")}`;
  const config = validateDeploymentConfig({ version: 1, environment: "staging", deploymentId: id,
    database: { host: base.hostname, port: Number(base.port), name }, origin: "https://mq.localhost",
    media: { root: "/var/lib/mq/media", minFreeBytes: 8 * 1024 ** 3 } });
  const passwords = Object.fromEntries(LOGIN_IDENTITIES.map(key => [key, randomBytes(32).toString("hex")]));
  const pools = [], checks = [];
  let failed = false, created = false, bootstrapped = false, db, failure, stage = "setup";
  const pool = url => {
    const value = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
    value.on("error", () => { failed = true; }); pools.push(value); return value;
  };
  const control = pool(base.href);
  const urlFor = key => {
    const url = new URL(base); url.pathname = `/${name}`;
    if (key !== "bootstrap") { url.username = config.roles[key]; url.password = passwords[key]; }
    return url.href;
  };
  const operator = pool(urlFor("bootstrap"));
  const check = async (label, action) => { stage = label; await action(); checks.push(label); console.log(`PASS production admin: ${label}`); };
  try {
    assert.deepEqual((await control.query("SELECT current_database() AS db,current_user AS actor")).rows[0], { db: "mq_test", actor: "mq_test" });
    await control.query(`CREATE DATABASE "${name}"`); created = true;
    for (const [key, value] of await logPrivacySettings()) if (!["log_destination", "log_line_prefix"].includes(key))
      await control.query(`ALTER DATABASE "${name}" SET ${key} TO '${value}'`);
    await bootstrapDeploymentDatabase(operator, config, passwords); bootstrapped = true;
    await migrateDeploymentDatabase(urlFor("migration"), config);
    await provisionDeploymentDatabase(operator, config);
    const maintenance = pool(urlFor("maintenance")), runtime = pool(urlFor("runtime"));
    db = createAuthDatabaseClient(urlFor("maintenance"));
    const execute = (input, password) => executeDeploymentAdminOperation({ pool: maintenance, db, config, input, password });
    await check("deployment tag, actual maintenance role and complete permission matrix required", async () => {
      await verifyDeploymentAdminConnection(maintenance, config);
      await assert.rejects(verifyDeploymentAdminConnection(operator, config));
      await assert.rejects(verifyDeploymentAdminConnection(runtime, config));
      await assert.rejects(verifyDeploymentAdminConnection(maintenance, { ...config, deploymentId: randomUUID() }));
      await operator.query(`GRANT SELECT ON mq_publish_private.signing_key TO "${config.roles.maintenance}"`);
      try { await assert.rejects(verifyDeploymentAdminConnection(maintenance, config)); }
      finally { await operator.query(`REVOKE SELECT ON mq_publish_private.signing_key FROM "${config.roles.maintenance}"`); }
    });
    const password = `Synthetic!${randomBytes(24).toString("hex")}`, replacement = `Replacement!${randomBytes(24).toString("hex")}`;
    let grant;
    await check("empty status and initialization create one dedicated account; duplicate refuses without orphan rows", async () => {
      assert.deepEqual(await execute({ operation: "status" }), { initialized: false });
      grant = await execute({ operation: "init", username: `synthetic_admin_${id.slice(0, 8)}` }, password);
      assert.equal(grant.version, 0);
      assert.deepEqual(await execute({ operation: "status" }), { initialized: true, ...grant, revoked: false });
      await assert.rejects(execute({ operation: "init", username: `second_admin_${id.slice(0, 8)}` }, password), error => error.code === "INITIALIZED");
      for (const table of ["User", "Account", "AdminGrant"]) assert.equal((await maintenance.query(`SELECT count(*)::int AS n FROM public."${table}"`)).rows[0].n, 1);
    });
    const session = async () => {
      const sid = randomUUID();
      await runtime.query('INSERT INTO public."Session"(id,"userId",token,"expiresAt","updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP+interval \'1 hour\',CURRENT_TIMESTAMP)',
        [sid, grant.userId, randomBytes(24).toString("hex")]);
      return sid;
    };
    await check("revoke, restore and password reset preserve CAS and invalidate all old sessions", async () => {
      for (const operation of ["revoke", "restore", "reset-password"]) {
        const sid = await session(), before = grant.version;
        grant = await execute({ operation, userId: grant.userId, expectedVersion: before }, replacement);
        assert.equal(grant.version, before + 1);
        assert.equal((await runtime.query('SELECT count(*)::int AS n FROM public."Session" WHERE id=$1', [sid])).rows[0].n, 0);
        await assert.rejects(execute({ operation, userId: grant.userId, expectedVersion: before }, replacement), error => error.code === "CONFLICT");
      }
      const hash = (await maintenance.query('SELECT password FROM public."Account" WHERE "userId"=$1', [grant.userId])).rows[0].password;
      assert.equal(await verifyPassword({ hash, password: replacement }), true);
      assert.equal(await verifyPassword({ hash, password }), false);
      assert.deepEqual((await maintenance.query('SELECT kind FROM public."AdminSecurityEvent" ORDER BY "eventAt"')).rows.map(row => row.kind),
        ["GRANTED", "REVOKED", "RESTORED", "CREDENTIAL_RESET"]);
    });
    await check("maintenance credentials cannot publish, read signing keys or perform runtime grant bypass", async () => {
      for (const sql of ['SELECT * FROM public.story', 'SELECT * FROM mq_publish_private.signing_key',
        'UPDATE public.story SET state=state WHERE false', 'DELETE FROM public."AdminGrant" WHERE false'])
        await assert.rejects(maintenance.query(sql), error => error.code === "42501");
      await assert.rejects(runtime.query('UPDATE public."AdminGrant" SET "revokedAt"=now(),version=version+1 WHERE id=1'), error => error.code === "42501");
    });
  } catch { failure = new Error(`PRODUCTION_ADMIN_TEST_FAILED: ${stage}`); }
  try {
    await db?.$disconnect();
    await Promise.all(pools.filter(value => value !== control).map(value => value.end()));
    if (created) {
      const deadline = Date.now() + 5000;
      while ((await control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1", [name])).rows[0].n) {
        assert.ok(Date.now() < deadline); await delay(25);
      }
      await control.query(`DROP DATABASE "${name}"`);
    }
    if (bootstrapped) for (const role of [...LOGIN_IDENTITIES.map(key => config.roles[key]), ...Object.values(config.roles.owners)])
      await control.query(`DROP ROLE "${role}"`);
  } catch { failure ??= new Error("PRODUCTION_ADMIN_TEST_CLEANUP_FAILED"); }
  finally { await control.end(); }
  if (failed) failure ??= new Error("PRODUCTION_ADMIN_TEST_CONNECTION_FAILED");
  if (failure) throw failure;
  return { passed: checks.length, synthetic: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runDeploymentAdminTests())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
