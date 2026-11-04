import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import pg from "pg";
import { databaseUrl } from "../db/environment.mjs";
import { runPrisma } from "../db/prisma-command.mjs";
import { configureTemporaryDatabaseLogging } from "../db/log-privacy.mjs";
import { startHttpsProxy } from "../auth/https-proxy.mjs";
import { applyAdminDatabasePrivileges } from "./privileges.mjs";
import { runAdminDatabaseTests } from "./database-tests.mjs";
import { runAdminHttpTests, runAdminHttpsTests } from "./http-tests.mjs";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { revokeAdmin, restoreAdmin } from "../../src/server/admin/maintenance.ts";
import { verifyMaintenanceConnection } from "./maintenance-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const next = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));
const { fetch, AbortSignal } = globalThis;
let stage = "validate isolated PostgreSQL target";
const id = () => randomUUID().replaceAll("-", "");

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startServer(port, env, servers, headers = {}, readiness = 200) {
  const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const server = { child, output: "", exited: false, failed: false };
  servers.push(server);
  child.stdout.on("data", chunk => { server.output += chunk; });
  child.stderr.on("data", chunk => { server.output += chunk; });
  child.once("error", () => { server.failed = true; });
  child.once("exit", () => { server.exited = true; });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.failed || server.exited) throw new Error("Test-owned application stopped (output withheld)");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/get-session`, { headers, signal: AbortSignal.timeout(1000) });
      if (response.status === readiness) return server;
    } catch { /* Bound startup by liveness and attempt count. */ }
    await delay(250);
  }
  throw new Error("Test-owned application readiness timed out (output withheld)");
}

async function stopServer(server) {
  if (server.exited) return;
  const stopped = new Promise(resolve => server.child.once("exit", resolve));
  server.child.kill();
  await Promise.race([stopped, delay(5000)]);
  if (!server.exited) {
    server.child.kill("SIGKILL");
    await Promise.race([stopped, delay(5000)]);
  }
  if (!server.exited) throw new Error("Test-owned application could not stop");
}

async function main() {
  const base = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  const runtimeRole = `mq_admin_rt_${id()}`;
  const maintenanceRole = `mq_admin_mt_${id()}`;
  const rolePasswords = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  const rolesCreated = [];
  const databases = [];
  const servers = [];
  const secrets = new Set(rolePasswords);
  let tls;
  let maintenance;
  let failure;
  async function isolatedDatabase() {
    const name = `mq_test_admin_${id()}`;
    assert.match(name, /^mq_test_admin_[a-f0-9]{32}$/);
    await control.query(`CREATE DATABASE "${name}"`);
    databases.push(name);
    await configureTemporaryDatabaseLogging(control, name);
    const owner = new URL(base);
    owner.pathname = `/${name}`;
    await runPrisma(["migrate", "deploy"], owner.href);
    await runPrisma(["migrate", "status"], owner.href);
    await runPrisma(["migrate", "deploy"], owner.href);
    await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], owner.href);
    const pool = new pg.Pool({ connectionString: owner.href, max: 1 });
    try {
      const migrations = (await pool.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name')).rows.map(row => row.migration_name);
      assert.deepEqual(migrations, ["202610230001_database_foundation", "202610230002_story_lifecycle", "202610230003_username_auth", "202610250004_admin_authorization", "202611030005_media_foundation", "202611040006_story_publication"]);
      await applyAdminDatabasePrivileges(pool, { runtimeRole, maintenanceRole, expectedDatabase: name });
    } finally { await pool.end(); }
    const runtime = new URL(owner);
    runtime.username = runtimeRole;
    runtime.password = rolePasswords[0];
    const maint = new URL(owner);
    maint.username = maintenanceRole;
    maint.password = rolePasswords[1];
    return { connectionString: owner.href, runtimeUrl: runtime.href, maintenanceUrl: maint.href };
  }
  async function verifyOfflineIdentityBoundary(target) {
    const name = new URL(target.connectionString).pathname.slice(1);
    const owner = new pg.Pool({ connectionString: target.connectionString, max: 1 });
    const runtime = new pg.Pool({ connectionString: target.runtimeUrl, max: 1 });
    const maint = new pg.Pool({ connectionString: target.maintenanceUrl, max: 1 });
    const rejected = error => error.message === "MAINTENANCE_IDENTITY_REJECTED";
    try {
      assert.equal(await verifyMaintenanceConnection(maint, name), maintenanceRole);
      await assert.rejects(verifyMaintenanceConnection(runtime, name), rejected);
      await assert.rejects(verifyMaintenanceConnection(owner, name), rejected);
      console.log("PASS real CLI identity preflight accepts maintenance and rejects runtime/migration identities");
      await owner.query(`GRANT INSERT (kind) ON public."AdminSecurityEvent" TO "${maintenanceRole}"`);
      try { await assert.rejects(verifyMaintenanceConnection(maint, name), rejected); }
      finally { await owner.query(`REVOKE INSERT (kind) ON public."AdminSecurityEvent" FROM "${maintenanceRole}"`); }
      console.log("PASS real CLI preflight refuses column-level audit-write privilege drift");
      await owner.query(`GRANT "${runtimeRole}" TO "${maintenanceRole}" WITH INHERIT FALSE`);
      try { await assert.rejects(verifyMaintenanceConnection(maint, name), rejected); }
      finally { await owner.query(`REVOKE "${runtimeRole}" FROM "${maintenanceRole}"`); }
      assert.equal(await verifyMaintenanceConnection(maint, name), maintenanceRole);
      console.log("PASS real CLI preflight refuses even non-inherited SET ROLE membership and recovers after removal");
    } finally { await Promise.allSettled([owner.end(), runtime.end(), maint.end()]); }
  }
  try {
    const identity = (await control.query("SELECT current_database() AS db, current_user AS usr, current_setting('server_version_num') AS version")).rows[0];
    assert.equal(identity.db, "mq_test");
    assert.equal(identity.usr, "mq_test");
    assert.ok(Number(identity.version) >= 180000 && Number(identity.version) < 190000);
    console.log(`PostgreSQL server_version_num=${identity.version}`);
    await access(new URL("../../.next/BUILD_ID", import.meta.url));
    stage = "create this run's nonprivileged database identities";
    // Session-only privacy controls precede statements containing generated test
    // passwords. Existing role/database/server defaults remain untouched.
    await control.query("SET log_statement = 'none'; SET log_min_error_statement = 'panic'; SET log_error_verbosity = 'terse'; SET log_parameter_max_length_on_error = 0");
    for (const [index, role] of [runtimeRole, maintenanceRole].entries()) {
      assert.match(role, /^mq_admin_(rt|mt)_[a-f0-9]{32}$/);
      assert.match(rolePasswords[index], /^[a-f0-9]{64}$/);
      await control.query(`CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${rolePasswords[index]}'`);
      rolesCreated.push(role);
    }
    stage = "migrate isolated database and verify constraints and role separation";
    const domain = await isolatedDatabase();
    await verifyOfflineIdentityBoundary(domain);
    const database = await runAdminDatabaseTests(domain);
    console.log(`Administrator database integration: ${database.passed}/${database.total} checks passed`);
    assert.equal(database.passed, database.total);
    stage = "migrate a separate empty database for production HTTP checks";
    const application = await isolatedDatabase();
    console.log("PASS two independent empty databases apply 001 -> 002 -> 003 -> 004, repeat deploy and schema drift checks");
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const secret = randomBytes(48).toString("base64url");
    secrets.add(secret);
    const env = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: application.runtimeUrl, MQ_AUTH_ENABLED: "true", AUTH_SECRET: secret,
      AUTH_ORIGIN: origin, AUTH_ALLOW_LOCAL_HTTP: "true", AUTH_PROXY_SECRET: "" };
    stage = "start production app using the restricted runtime database role";
    const plain = await startServer(port, env, servers);
    stage = "real HTTP administrator boundary and maintenance integration";
    const httpResult = await runAdminHttpTests({ ...application, runtimeRole, origin });
    httpResult.secrets.forEach(value => secrets.add(value));
    console.log(`Administrator HTTP integration: ${httpResult.passed}/${httpResult.total} checks passed`);
    await stopServer(plain);
    stage = "verify the disabled authentication configuration denies admin access";
    const disabledPort = await unusedPort();
    const disabled = await startServer(disabledPort, { ...env, MQ_AUTH_ENABLED: "false" }, servers, {}, 503);
    for (const path of ["/admin", "/api/admin/status"]) {
      const response = await fetch(`http://127.0.0.1:${disabledPort}${path}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 503);
    }
    await stopServer(disabled);
    console.log("PASS disabled authentication fails closed on both administrator entrypoints");
    stage = "verify real HTTPS admin sessions and protected ingress";
    const backendPort = await unusedPort();
    tls = await startHttpsProxy(backendPort);
    secrets.add(tls.proxySecret);
    await startServer(backendPort, { ...env, AUTH_ORIGIN: tls.origin, AUTH_ALLOW_LOCAL_HTTP: "false", AUTH_PROXY_SECRET: tls.proxySecret }, servers,
      { "x-mq-proxy-key": tls.proxySecret, "x-mq-client-ip": "127.0.0.1" });
    const httpsResult = await runAdminHttpsTests({ connectionString: application.connectionString, origin: tls.origin,
      backendOrigin: `http://127.0.0.1:${backendPort}`, ca: tls.ca, credentials: httpResult, secrets });
    httpsResult.secrets.forEach(value => secrets.add(value));
    console.log(`Administrator HTTPS integration: ${httpsResult.passed}/${httpsResult.total} checks passed`);
    if (process.env.MQ_ADMIN_BROWSER_MODULE) {
      stage = "real desktop and mobile administrator browser regression";
      assert.ok(process.env.ADMIN_BROWSER_EVIDENCE_DIR, "Browser evidence directory must be explicit");
      const { runBrowser } = await import(pathToFileURL(process.env.MQ_ADMIN_BROWSER_MODULE).href);
      const counters = new pg.Pool({ connectionString: application.connectionString, max: 1 });
      try {
        await counters.query('DELETE FROM "AuthRateLimit"');
        await counters.query('DELETE FROM "RateLimit"');
      } finally { await counters.end(); }
      maintenance = createAuthDatabaseClient(application.maintenanceUrl);
      let grant = httpResult.grant;
      await runBrowser({ baseURL: tls.origin, evidenceDirectory: process.env.ADMIN_BROWSER_EVIDENCE_DIR,
        adminUsername: httpResult.adminUsername, adminPassword: httpResult.adminPassword,
        ordinaryUsername: httpResult.ordinaryUsername, ordinaryPassword: httpResult.ordinaryPassword,
        ignoreHTTPSErrors: true, expectedSecure: true,
        async revokeAdmin() { grant = await revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version }); },
        async restoreAdmin() { grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version }); },
      });
      console.log("PASS real administrator desktop/mobile browser checks");
    }
    stage = "verify application logs contain no synthetic sensitive values";
    const inspection = new pg.Pool({ connectionString: application.connectionString, max: 1 });
    try {
      const rows = (await inspection.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
      rows.forEach(row => secrets.add(row.value));
    } finally { await inspection.end(); }
    const captured = servers.map(server => server.output).join("\n");
    assert.ok(!captured.includes("@accounts.invalid"));
    assert.ok([...secrets].every(secretValue => !captured.includes(secretValue)));
    assert.ok(!captured.includes(application.connectionString) && !captured.includes(application.runtimeUrl));
    console.log("PASS production application logs contain no synthetic password, internal email, session token or database credential");
  } catch (error) { failure = error; }
  finally {
    for (const result of await Promise.allSettled(servers.map(stopServer))) if (result.status === "rejected") failure ??= result.reason;
    try { await maintenance?.$disconnect(); } catch (error) { failure ??= error; }
    try { await tls?.close(); } catch (error) { failure ??= error; }
    for (const name of databases) {
      try { await control.query(`DROP DATABASE "${name}"`); } catch (error) { failure ??= error; }
    }
    for (const role of rolesCreated) {
      try { await control.query(`DROP ROLE "${role}"`); } catch (error) { failure ??= error; }
    }
    try { await control.end(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  console.log("PASS removed only this run's databases, nonprivileged roles, TLS files and application processes");
}

try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error.code ?? "") ? error.code : "ERROR";
  console.error(`Administrator integration FAILED at: ${stage} (${code}; raw errors and credentials withheld)`);
  process.exitCode = 1;
}
