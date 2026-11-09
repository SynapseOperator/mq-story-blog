import { sessionFixture } from "../auth/session-fixture.mjs";
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
import { applyAdminDraftDatabasePrivileges } from "./privileges.mjs";
import { runDraftDatabaseTests } from "./database-tests.mjs";
import { runDraftHttpTests, runDraftHttpsTests } from "./http-tests.mjs";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin } from "../../src/server/admin/maintenance.ts";
import { createStoryService } from "../../src/server/stories/service.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const next = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));
const { fetch, AbortSignal } = globalThis;
let stage = "validate the test-only PostgreSQL connection";
const id = () => randomUUID().replaceAll("-", "");

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startServer(port, env, servers, headers = {}, expected = 200) {
  const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const server = { child, output: "", exited: false, failed: false };
  servers.push(server);
  child.stdout.on("data", value => { server.output += value; });
  child.stderr.on("data", value => { server.output += value; });
  child.once("error", () => { server.failed = true; });
  child.once("exit", () => { server.exited = true; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.failed || server.exited) throw new Error("Owned application stopped (output withheld)");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/get-session`, { headers, signal: AbortSignal.timeout(1000) });
      if (response.status === expected) return server;
    } catch { /* Only bounded readiness polling; never dump process output. */ }
    await delay(250);
  }
  throw new Error("Owned application readiness timed out (output withheld)");
}

async function stopServer(server) {
  if (server.exited) return;
  const stopped = new Promise(resolve => server.child.once("exit", resolve));
  server.child.kill();
  await Promise.race([stopped, delay(5000)]);
  if (!server.exited) { server.child.kill("SIGKILL"); await Promise.race([stopped, delay(5000)]); }
  if (!server.exited) throw new Error("Owned application could not stop");
}

async function main() {
  const base = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  const runtimeRole = `mq_admin_rt_${id()}`;
  const maintenanceRole = `mq_admin_mt_${id()}`;
  const rolePasswords = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  const roles = [];
  const databases = [];
  const servers = [];
  const secrets = new Set([...rolePasswords, sessionFixture.key]);
  let tls;
  let failure;
  async function isolatedDatabase() {
    const name = `mq_test_admin_${id()}`;
    assert.match(name, /^mq_test_admin_[a-f0-9]{32}$/);
    await control.query(`CREATE DATABASE "${name}"`);
    databases.push(name);
    await configureTemporaryDatabaseLogging(control, name);
    const owner = new URL(base); owner.pathname = `/${name}`;
    await runPrisma(["migrate", "deploy"], owner.href);
    await runPrisma(["migrate", "status"], owner.href);
    await runPrisma(["migrate", "deploy"], owner.href);
    await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], owner.href);
    const pool = new pg.Pool({ connectionString: owner.href, max: 1 });
    try {
      const migrations = (await pool.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name')).rows.map(row => row.migration_name);
      assert.deepEqual(migrations, ["202610230001_database_foundation", "202610230002_story_lifecycle", "202610230003_username_auth", "202610250004_admin_authorization", "202611030005_media_foundation", "202611040006_story_publication", "202611040007_story_likes", "202611050008_story_comments", "202611080009_protected_sessions"]);
      await applyAdminDraftDatabasePrivileges(pool, { runtimeRole, maintenanceRole, expectedDatabase: name });
      await pool.query(`GRANT SELECT ON public.story_like,public.story_comment TO "${runtimeRole}"`);
    } finally { await pool.end(); }
    const runtime = new URL(owner); runtime.username = runtimeRole; runtime.password = rolePasswords[0];
    const maintenance = new URL(owner); maintenance.username = maintenanceRole; maintenance.password = rolePasswords[1];
    return { connectionString: owner.href, runtimeUrl: runtime.href, maintenanceUrl: maintenance.href };
  }
  try {
    const identity = (await control.query("SELECT current_database() AS db,current_user AS usr,current_setting('server_version_num') AS version")).rows[0];
    assert.equal(identity.db, "mq_test"); assert.equal(identity.usr, "mq_test");
    assert.ok(Number(identity.version) >= 180000 && Number(identity.version) < 190000);
    console.log(`PostgreSQL server_version_num=${identity.version}`);
    await access(new URL("../../.next/BUILD_ID", import.meta.url));
    stage = "create this invocation's nonprivileged roles";
    await control.query("SET log_statement='none'; SET log_min_error_statement='panic'; SET log_error_verbosity='terse'; SET log_parameter_max_length_on_error=0");
    for (const [index, role] of [runtimeRole, maintenanceRole].entries()) {
      assert.match(role, /^mq_admin_(rt|mt)_[a-f0-9]{32}$/); assert.match(rolePasswords[index], /^[a-f0-9]{64}$/);
      await control.query(`CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${rolePasswords[index]}'`);
      roles.push(role);
    }
    stage = "empty database migration and actual column privilege regression";
    const domain = await isolatedDatabase();
    const database = await runDraftDatabaseTests({ ...domain, runtimeRole });
    assert.equal(database.passed, database.total);
    console.log(`Draft PostgreSQL integration: ${database.passed}/${database.total} checks passed`);
    stage = "separate empty database migration for production HTTP validation";
    const application = await isolatedDatabase();
    console.log("PASS two independently migrated empty databases: 001 -> 008, repeat deploy and schema diff");
    const port = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const secret = randomBytes(48).toString("base64url"); secrets.add(secret);
    const env = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: application.runtimeUrl,
      MQ_AUTH_ENABLED: "true", AUTH_SECRET: secret, SESSION_STORAGE_KEY: sessionFixture.key, AUTH_ORIGIN: origin, AUTH_ALLOW_LOCAL_HTTP: "true", AUTH_PROXY_SECRET: "" };
    const plain = await startServer(port, env, servers);
    stage = "production HTTP draft permissions, transaction and concurrency tests";
    const httpResult = await runDraftHttpTests({ ...application, runtimeRole, origin });
    httpResult.secrets.forEach(value => secrets.add(value));
    assert.equal(httpResult.passed, httpResult.total);
    console.log(`Draft HTTP integration: ${httpResult.passed}/${httpResult.total} checks passed`);
    await stopServer(plain);
    stage = "disabled authentication fails closed for private draft endpoints";
    const disabledPort = await unusedPort();
    const disabled = await startServer(disabledPort, { ...env, MQ_AUTH_ENABLED: "false" }, servers, {}, 503);
    for (const path of ["/api/admin/stories", `/api/admin/stories/${randomUUID()}/draft`]) {
      const result = await fetch(`http://127.0.0.1:${disabledPort}${path}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(result.status, 503);
    }
    await stopServer(disabled);
    console.log("PASS disabled authentication rejects both private draft resources");
    stage = "production HTTPS draft operations and trusted ingress validation";
    const backendPort = await unusedPort(); tls = await startHttpsProxy(backendPort); secrets.add(tls.proxySecret);
    const secureServer = await startServer(backendPort, { ...env, AUTH_ORIGIN: tls.origin, AUTH_ALLOW_LOCAL_HTTP: "false", AUTH_PROXY_SECRET: tls.proxySecret }, servers,
      { "x-mq-proxy-key": tls.proxySecret, "x-mq-client-ip": "127.0.0.1" });
    const httpsResult = await runDraftHttpsTests({ connectionString: application.connectionString, origin: tls.origin,
      backendOrigin: `http://127.0.0.1:${backendPort}`, ca: tls.ca, credentials: httpResult, secrets });
    assert.equal(httpsResult.passed, httpsResult.total);
    console.log(`Draft HTTPS integration: ${httpsResult.passed}/${httpsResult.total} checks passed`);
    if (process.env.MQ_DRAFT_BROWSER_MODULE) {
      stage = "real production desktop and mobile browser regression";
      assert.ok(process.env.DRAFT_BROWSER_EVIDENCE_DIR, "Explicit evidence directory required");
      const counters = new pg.Pool({ connectionString: application.connectionString, max: 1 });
      try { await counters.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"'); }
      finally { await counters.end(); }
      // The editor returns to the real public catalog, not the former demo data.
      // Publish one synthetic star only in this invocation's isolated database.
      const fixtureClient = createAuthDatabaseClient(application.connectionString);
      let publicStory;
      try {
        const lifecycle = createStoryService(fixtureClient);
        const draft = await lifecycle.createDraft({ slug: `editor-public-${id()}`, kind: "STAR", slotId: "star-3",
          title: "合成公开故事 · 编辑器返回验收", content: { version: 1, blocks: [{ type: "paragraph", text: "仅用于隔离浏览器回归的合成公开正文。" }] } });
        publicStory = await lifecycle.publish({ storyId: draft.id, expectedVersion: draft.version });
      } finally { await fixtureClient.$disconnect(); }
      const { runBrowser, runFreshCampfireBrowser } = await import(pathToFileURL(process.env.MQ_DRAFT_BROWSER_MODULE).href);
      async function snapshotDatabase() {
        const pool = new pg.Pool({ connectionString: application.connectionString, max: 1 });
        try {
          const stories = (await pool.query('SELECT id, version, published_revision_id FROM story ORDER BY id')).rows;
          const revisions = (await pool.query('SELECT count(*)::int AS count FROM story_revision')).rows[0].count;
          return { stories, revisions };
        } finally { await pool.end(); }
      }
      await runBrowser({ baseURL: tls.origin, evidenceDirectory: process.env.DRAFT_BROWSER_EVIDENCE_DIR,
        admin: httpResult.admin, regular: httpResult.regular, privateCanaries: httpResult.privateCanaries,
        publicStory: { id: publicStory.id, slug: publicStory.slug, title: "合成公开故事 · 编辑器返回验收" },
        snapshotDatabase,
        ignoreHTTPSErrors: true, expectedSecure: true });
      console.log("PASS real production desktop/mobile draft and existing-reader browser regression");
      if (runFreshCampfireBrowser) {
        // Existing HTTP tests intentionally retain their singleton CAMPFIRE.
        // Verify the first UI creation in a third empty, owned database instead
        // of deleting that fixture or weakening the original uniqueness test.
        stage = "first CAMPFIRE UI creation in a separate empty database";
        const fresh = await isolatedDatabase();
        const admin = { username: `editor_${id().slice(0, 10)}`, password: `MqTest!${randomBytes(24).toString("base64url")}` };
        secrets.add(admin.password);
        const maintenance = createAuthDatabaseClient(fresh.maintenanceUrl);
        try { await initializeAdmin(maintenance, admin); } finally { await maintenance.$disconnect(); }
        await stopServer(secureServer);
        await startServer(backendPort, { ...env, DATABASE_URL: fresh.runtimeUrl, AUTH_ORIGIN: tls.origin,
          AUTH_ALLOW_LOCAL_HTTP: "false", AUTH_PROXY_SECRET: tls.proxySecret }, servers,
          { "x-mq-proxy-key": tls.proxySecret, "x-mq-client-ip": "127.0.0.1" });
        await runFreshCampfireBrowser({ baseURL: tls.origin, evidenceDirectory: process.env.DRAFT_BROWSER_EVIDENCE_DIR,
          admin, ignoreHTTPSErrors: true, expectedSecure: true });
        const freshInspection = new pg.Pool({ connectionString: fresh.connectionString, max: 1 });
        try {
          const campfires = (await freshInspection.query("SELECT kind,state,slot_id FROM story WHERE kind='CAMPFIRE'")).rows;
          assert.equal(campfires.length, 1); assert.equal(campfires[0].state, "DRAFT"); assert.equal(campfires[0].slot_id, null);
          console.log("PASS first UI CAMPFIRE persists as one slot-free draft in its separate database");
          const rows = (await freshInspection.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT "tokenCiphertext" AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
          rows.forEach(row => secrets.add(row.value));
        } finally { await freshInspection.end(); }
      }
    }
    stage = "production application log privacy regression";
    const inspection = new pg.Pool({ connectionString: application.connectionString, max: 1 });
    try {
      const rows = (await inspection.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT "tokenCiphertext" AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
      rows.forEach(row => secrets.add(row.value));
    } finally { await inspection.end(); }
    const captured = servers.map(server => server.output).join("\n");
    assert.ok(!captured.includes("@accounts.invalid"));
    assert.ok([...secrets, ...httpResult.privateCanaries].every(value => !captured.includes(value)));
    assert.ok(!captured.includes(application.connectionString) && !captured.includes(application.runtimeUrl));
    assert.ok(!captured.includes("SYNTHETIC_DATABASE_FAILURE"));
    console.log("PASS application logs omit synthetic passwords, emails, session tokens, DB credentials and private draft canaries");
  } catch (error) { failure = error; }
  finally {
    for (const result of await Promise.allSettled(servers.map(stopServer))) if (result.status === "rejected") failure ??= result.reason;
    try { await tls?.close(); } catch (error) { failure ??= error; }
    // Exact resources recorded after creation; no FORCE, shared reset or prune.
    for (const name of databases) { try { await control.query(`DROP DATABASE "${name}"`); } catch (error) { failure ??= error; } }
    for (const role of roles) { try { await control.query(`DROP ROLE "${role}"`); } catch (error) { failure ??= error; } }
    try { await control.end(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  console.log("PASS removed only this invocation's databases, roles, HTTPS files and application processes");
}

try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error.code ?? "") ? error.code : "ERROR";
  console.error(`Draft integration FAILED at: ${stage} (${code}; raw errors and credentials withheld)`);
  process.exitCode = 1;
}
