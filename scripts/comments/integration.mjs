import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { databaseUrl } from "../db/environment.mjs";
import { runPrisma } from "../db/prisma-command.mjs";
import { configureTemporaryDatabaseLogging, verifyDatabaseLogging } from "../db/log-privacy.mjs";
import { applyAdminDatabasePrivileges } from "../admin/privileges.mjs";
import { startHttpsProxy } from "../auth/https-proxy.mjs";
import { applyCommentDatabasePrivileges, initializeCommentKey } from "./privileges.mjs";
import { runCommentDatabaseTests } from "./database-tests.mjs";
import { runCommentHttpTests } from "./http-tests.mjs";
import { transport, commentPath, moderatePath, assertCommentHeaders, assertCommentPage, assertCommentError } from "./test-support.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const next = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));
let stage = "validate isolated PostgreSQL target";
async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); return address.port;
}
async function startServer(port, env, servers, headers = {}, ready = "/api/auth/get-session") {
  const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const server = { child, output: "", exited: false, failed: false }; servers.push(server);
  child.stdout.on("data", chunk => { server.output += chunk; }); child.stderr.on("data", chunk => { server.output += chunk; });
  child.once("error", () => { server.failed = true; }); child.once("exit", () => { server.exited = true; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.failed || server.exited) throw new Error("COMMENT_TEST_SERVER_STOPPED");
    try {
      if ((await globalThis.fetch(`http://127.0.0.1:${port}${ready}`, { headers, signal: AbortSignal.timeout(1000) })).status === 200) return server;
    } catch { /* Bounded readiness; process output is retained only for privacy checks. */ }
    await delay(250);
  }
  throw new Error("COMMENT_TEST_SERVER_NOT_READY");
}
async function stopServer(server) {
  if (server.exited) return;
  const stopped = new Promise(done => server.child.once("exit", done)); server.child.kill();
  await Promise.race([stopped, delay(5000)]);
  if (!server.exited) { server.child.kill("SIGKILL"); await Promise.race([stopped, delay(5000)]); }
  if (!server.exited) throw new Error("COMMENT_TEST_SERVER_WILL_NOT_STOP");
}

async function main() {
  const base = await databaseUrl("test"), control = new pg.Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  const suffix = randomUUID().replaceAll("-", ""), runtimeRole = `mq_admin_rt_${suffix}`, maintenanceRole = `mq_admin_mt_${suffix}`;
  const commentOwnerRole = `mq_comment_owner_${suffix}`;
  const passwords = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")], key = randomBytes(32).toString("hex");
  const databases = [], roles = [], servers = [], secrets = new Set([base, key, ...passwords]), privateText = new Set();
  let tls, failure;
  async function isolated() {
    const name = `mq_test_admin_${randomUUID().replaceAll("-", "")}`;
    assert.match(name, /^mq_test_admin_[a-f0-9]{32}$/);
    await control.query(`CREATE DATABASE "${name}"`); databases.push(name);
    await configureTemporaryDatabaseLogging(control, name);
    const ownerUrl = new URL(base); ownerUrl.pathname = `/${name}`;
    const owner = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    try {
      await verifyDatabaseLogging(owner);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
      await runPrisma(["migrate", "deploy"], ownerUrl.href);
      await runPrisma(["migrate", "status"], ownerUrl.href);
      await runPrisma(["migrate", "deploy"], ownerUrl.href);
      await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], ownerUrl.href);
      const expected = (await readdir(new URL("../../prisma/migrations/", import.meta.url), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort();
      const history = (await owner.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')).rows.map(row => row.migration_name);
      assert.deepEqual(history, expected);
      await applyAdminDatabasePrivileges(owner, { runtimeRole, maintenanceRole, expectedDatabase: name });
      await applyCommentDatabasePrivileges(owner, { runtimeRole, commentOwnerRole, expectedDatabase: name });
      await initializeCommentKey(owner, { expectedDatabase: name, key });
    } finally { await owner.end(); }
    const runtime = new URL(ownerUrl); runtime.username = runtimeRole; runtime.password = passwords[0];
    const maintenance = new URL(ownerUrl); maintenance.username = maintenanceRole; maintenance.password = passwords[1];
    for (const url of [ownerUrl.href, runtime.href, maintenance.href]) secrets.add(url);
    return { connectionString: ownerUrl.href, runtimeUrl: runtime.href, maintenanceUrl: maintenance.href,
      runtimeRole, maintenanceRole, commentOwnerRole, key, name };
  }
  try {
    const info = (await control.query("SELECT current_database() AS db,current_user AS usr,current_setting('server_version_num') AS version")).rows[0];
    assert.equal(info.db, "mq_test"); assert.equal(info.usr, "mq_test"); assert.ok(Number(info.version) >= 180000 && Number(info.version) < 190000);
    console.log(`PostgreSQL server_version_num=${info.version}`);
    await access(new URL("../../.next/BUILD_ID", import.meta.url));
    await control.query("SET log_statement='none'; SET log_min_error_statement='panic'; SET log_error_verbosity='terse'; SET log_parameter_max_length_on_error=0");
    for (const [index, role] of [runtimeRole, maintenanceRole].entries()) {
      assert.match(role, /^mq_admin_(rt|mt)_[a-f0-9]{32}$/);
      await control.query(`CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords[index]}'`); roles.push(role);
    }
    assert.match(commentOwnerRole, /^mq_comment_owner_[a-f0-9]{32}$/);
    await control.query(`CREATE ROLE "${commentOwnerRole}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`); roles.push(commentOwnerRole);
    stage = "real database constraints, signed moderation and lock ordering";
    const database = await runCommentDatabaseTests(await isolated());
    assert.equal(database.passed, database.total); console.log(`Comments PostgreSQL: ${database.passed}/${database.total} checks passed`);
    for (const secure of [false, true]) {
      stage = `${secure ? "HTTPS" : "HTTP"} isolated application`;
      const application = await isolated(), port = await unusedPort();
      if (secure) { tls = await startHttpsProxy(port); secrets.add(tls.proxySecret); }
      const origin = secure ? tls.origin : `http://127.0.0.1:${port}`, secret = randomBytes(48).toString("base64url"); secrets.add(secret);
      const env = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: application.runtimeUrl,
        MQ_AUTH_ENABLED: "true", AUTH_SECRET: secret, AUTH_ORIGIN: origin, AUTH_ALLOW_LOCAL_HTTP: secure ? "false" : "true",
        AUTH_PROXY_SECRET: secure ? tls.proxySecret : "", MQ_PUBLISH_ENABLED: "false", MQ_MEDIA_ENABLED: "false",
        MQ_COMMENTS_ENABLED: "true", MQ_COMMENT_SIGNING_KEY: key };
      const ingress = secure ? { "x-mq-proxy-key": tls.proxySecret, "x-mq-client-ip": "127.0.0.1" } : {};
      let server = await startServer(port, env, servers, ingress);
      const result = await runCommentHttpTests({ ...application, origin, authSecret: secret, ca: secure ? tls.ca : undefined,
        backendOrigin: `http://127.0.0.1:${port}`, async restartServer() {
          await stopServer(server); server = await startServer(port, env, servers, ingress);
        } });
      assert.equal(result.passed, result.total); result.secrets.forEach(value => secrets.add(value));
      console.log(`Comments ${secure ? "HTTPS" : "HTTP"}: ${result.passed}/${result.total} checks passed`);
      await stopServer(server);
      stage = "disabled comments and disabled authentication retain public reads and refuse writes";
      for (const flags of [{ MQ_COMMENTS_ENABLED: "false" }, { MQ_AUTH_ENABLED: "false" }]) {
        const disabled = await startServer(port, { ...env, ...flags }, servers, ingress, "/api/stories");
        const request = transport(origin, secrets, secure ? tls.ca : undefined);
        assertCommentPage(await request(commentPath(result.fixtures.first.id)), { count: result.publicCount });
        assertCommentError(await request(commentPath(result.fixtures.first.id), { method: "POST", headers: { "idempotency-key": randomUUID() },
          body: { body: "合成禁用边界测试", identity: "anonymous" } }), 503, "COMMENT_UNAVAILABLE");
        const moderation = await request(moderatePath(result.pendingId), { method: "POST", jar: result.adminJar,
          body: { action: "approve", expectedVersion: 0 } });
        assert.equal(moderation.status, 503); assertCommentHeaders(moderation);
        await stopServer(disabled);
      }
      result.logOnly.forEach(value => privateText.add(value));
      if (tls) { await tls.close(); tls = undefined; }
    }
    stage = "application log privacy";
    const logs = servers.map(server => server.output).join("\n");
    assert.ok(!logs.includes("@accounts.invalid") && !logs.includes("permission denied for table") && !logs.includes("PrismaClientKnownRequestError"));
    for (const value of [...secrets, ...privateText]) assert.ok(!value || !logs.includes(value));
    console.log("PASS comments logs omit credentials, session tokens, submitted text, idempotency keys and SQL errors");
  } catch (error) { failure = error; }
  finally {
    for (const result of await Promise.allSettled(servers.map(stopServer))) if (result.status === "rejected") failure ??= result.reason;
    try { await tls?.close(); } catch (error) { failure ??= error; }
    for (const name of databases) { try { await control.query(`DROP DATABASE "${name}"`); } catch (error) { failure ??= error; } }
    for (const role of roles) { try { await control.query(`DROP ROLE "${role}"`); } catch (error) { failure ??= error; } }
    try { await control.end(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  console.log("PASS removed only this invocation's temporary databases, roles, TLS and application processes");
}
try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,40}$/.test(error?.code ?? "") ? error.code : "ERROR";
  console.error(`Comments integration FAILED at ${stage}${error.commentsStage ? ` / ${error.commentsStage}` : ""} (${code}; private details withheld)`);
  process.exitCode = 1;
}
