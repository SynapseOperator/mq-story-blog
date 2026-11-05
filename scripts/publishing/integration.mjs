import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { databaseUrl } from "../db/environment.mjs";
import { runPrisma } from "../db/prisma-command.mjs";
import { configureTemporaryDatabaseLogging, verifyDatabaseLogging } from "../db/log-privacy.mjs";
import { applyAdminDraftDatabasePrivileges } from "../admin-drafts/privileges.mjs";
import { applyMediaDatabasePrivileges } from "../media/privileges.mjs";
import { startHttpsProxy } from "../auth/https-proxy.mjs";
import { applyPublishingDatabasePrivileges, initializePublishingKey } from "./privileges.mjs";
import { runPublishingDatabaseTests } from "./database-tests.mjs";
import { runPublishingHttpTests } from "./http-tests.mjs";
import { runPublishingBrowser } from "./browser-tests.mjs";
import { runPublicationBackupTests } from "./backup-tests.mjs";
import { runPublishingEditorBrowser } from "./editor-browser-tests.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const next = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));
const { fetch } = globalThis;
let stage = "validate temporary database target";
async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); return address.port;
}
async function startServer(port, env, servers, headers = {}) {
  const child = spawn(process.execPath, ["--import", new URL("./file-barrier.mjs", import.meta.url).href,
    next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const server = { child, output: "", exited: false, failed: false }; servers.push(server);
  child.stdout.on("data", chunk => { server.output += chunk; }); child.stderr.on("data", chunk => { server.output += chunk; });
  child.once("error", () => { server.failed = true; }); child.once("exit", () => { server.exited = true; });
  for (let n = 0; n < 120; n++) {
    if (server.failed || server.exited) throw new Error("PUBLISH_TEST_SERVER_STOPPED");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/get-session`, { headers, signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return server;
    } catch { /* Poll only this owned process; no unredacted output. */ }
    await delay(250);
  }
  throw new Error("PUBLISH_TEST_SERVER_NOT_READY");
}
async function stopServer(server) {
  if (server.exited) return;
  const exited = new Promise(done => server.child.once("exit", done)); server.child.kill();
  await Promise.race([exited, delay(5000)]);
  if (!server.exited) { server.child.kill("SIGKILL"); await Promise.race([exited, delay(5000)]); }
  if (!server.exited) throw new Error("PUBLISH_TEST_SERVER_WILL_NOT_STOP");
}

async function main() {
  const base = await databaseUrl("test"), control = new pg.Pool({ connectionString: base, max: 1 });
  const suffix = randomUUID().replaceAll("-", ""), runtimeRole = `mq_admin_rt_${suffix}`, maintenanceRole = `mq_admin_mt_${suffix}`;
  const publicationOwnerRole = `mq_publish_owner_${suffix}`;
  const passwords = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")], key = randomBytes(32).toString("hex");
  const databases = [], roles = [], servers = [], secrets = new Set([...passwords, key]);
  let workspace, tls, failure;
  async function isolated() {
    const name = `mq_test_admin_${randomUUID().replaceAll("-", "")}`;
    assert.match(name, /^mq_test_admin_[a-f0-9]{32}$/);
    await control.query(`CREATE DATABASE "${name}"`); databases.push(name);
    await configureTemporaryDatabaseLogging(control, name);
    const ownerUrl = new URL(base); ownerUrl.pathname = `/${name}`;
    await runPrisma(["migrate", "deploy"], ownerUrl.href);
    await runPrisma(["migrate", "status"], ownerUrl.href);
    await runPrisma(["migrate", "deploy"], ownerUrl.href);
    await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], ownerUrl.href);
    const owner = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    try {
      await verifyDatabaseLogging(owner);
      const migrations = (await owner.query('SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY migration_name')).rows.map(row => row.migration_name);
      assert.deepEqual(migrations, ["202610230001_database_foundation", "202610230002_story_lifecycle",
        "202610230003_username_auth", "202610250004_admin_authorization", "202611030005_media_foundation", "202611040006_story_publication", "202611040007_story_likes", "202611050008_story_comments"]);
      await applyAdminDraftDatabasePrivileges(owner, { runtimeRole, maintenanceRole, expectedDatabase: name });
      await applyMediaDatabasePrivileges(owner, { runtimeRole, expectedDatabase: name });
      await applyPublishingDatabasePrivileges(owner, { runtimeRole, publicationOwnerRole, expectedDatabase: name });
      await initializePublishingKey(owner, { expectedDatabase: name, key });
      await owner.query(`GRANT SELECT ON public.story_like TO "${runtimeRole}"`);
    } finally { await owner.end(); }
    const runtime = new URL(ownerUrl); runtime.username = runtimeRole; runtime.password = passwords[0];
    const maintenance = new URL(ownerUrl); maintenance.username = maintenanceRole; maintenance.password = passwords[1];
    return { connectionString: ownerUrl.href, runtimeUrl: runtime.href, maintenanceUrl: maintenance.href, name };
  }
  try {
    const info = (await control.query("SELECT current_database() AS db,current_user AS usr,current_setting('server_version_num') AS version")).rows[0];
    assert.equal(info.db, "mq_test"); assert.equal(info.usr, "mq_test"); assert.ok(Number(info.version) >= 180000 && Number(info.version) < 190000);
    console.log(`PostgreSQL server_version_num=${info.version}`);
    await access(new URL("../../.next/BUILD_ID", import.meta.url));
    stage = "create this run's isolated restricted roles";
    await control.query("SET log_statement='none'; SET log_min_error_statement='panic'; SET log_error_verbosity='terse'; SET log_parameter_max_length_on_error=0");
    for (const [index, role] of [runtimeRole, maintenanceRole].entries()) {
      assert.match(role, /^mq_admin_(rt|mt)_[a-f0-9]{32}$/);
      await control.query(`CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords[index]}'`); roles.push(role);
    }
    await control.query(`CREATE ROLE "${publicationOwnerRole}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`); roles.push(publicationOwnerRole);
    stage = "empty migration and signed publication database tests";
    const domain = await isolated();
    const result = await runPublishingDatabaseTests({ ...domain, runtimeRole, publicationOwnerRole, key });
    assert.equal(result.passed, result.total); console.log(`Publishing PostgreSQL: ${result.passed}/${result.total} checks passed`);
    workspace = await mkdtemp(join(tmpdir(), "mq-publishing-"));
    const devRoot = join(workspace, "private-development"); await mkdir(devRoot, { mode: 0o700 }); secrets.add(workspace);
    for (const secure of [false, true]) {
      stage = `${secure ? "HTTPS" : "HTTP"} isolated application setup`;
      const application = await isolated(); const storageRoot = join(workspace, secure ? "private-https" : "private-http");
      await mkdir(storageRoot, { mode: 0o700 });
      const port = await unusedPort(); if (secure) { tls = await startHttpsProxy(port); secrets.add(tls.proxySecret); }
      const origin = secure ? tls.origin : `http://127.0.0.1:${port}`, secret = randomBytes(48).toString("base64url"); secrets.add(secret);
      const env = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: application.runtimeUrl,
        MQ_AUTH_ENABLED: "true", AUTH_SECRET: secret, AUTH_ORIGIN: origin, AUTH_ALLOW_LOCAL_HTTP: secure ? "false" : "true", AUTH_PROXY_SECRET: secure ? tls.proxySecret : "",
        MQ_MEDIA_ENABLED: "true", MQ_MEDIA_ENV: "test", MQ_MEDIA_DEVELOPMENT_ROOT: devRoot, MQ_MEDIA_TEST_ROOT: storageRoot,
        MQ_PUBLISH_ENABLED: "true", MQ_PUBLISH_SIGNING_KEY: key,
        MQ_PUBLISH_TEST_GATE_FILE: join(workspace, secure ? "https-gate.json" : "http-gate.json") };
      const ingress = secure ? { "x-mq-proxy-key": tls.proxySecret, "x-mq-client-ip": "127.0.0.1" } : {};
      const server = await startServer(port, env, servers, ingress);
      stage = `production ${secure ? "HTTPS" : "HTTP"} publishing, file integrity and public isolation`;
      const httpResult = await runPublishingHttpTests({ ...application, runtimeRole, origin, ca: secure ? tls.ca : undefined, storageRoot,
        gateFile: env.MQ_PUBLISH_TEST_GATE_FILE });
      assert.equal(httpResult.passed, httpResult.total); httpResult.secrets.forEach(value => secrets.add(value));
      console.log(`Publishing ${secure ? "HTTPS" : "HTTP"}: ${httpResult.passed}/${httpResult.total} checks passed`);
      if (secure) {
        stage = "production browser regression on desktop, touch and reduced motion";
        const owner = new pg.Pool({ connectionString: application.connectionString, max: 1 });
        try { await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"'); } finally { await owner.end(); }
        await runPublishingBrowser({ baseURL: origin, admin: httpResult.admin, first: httpResult.first,
          evidenceDirectory: process.env.PUBLISH_BROWSER_EVIDENCE_DIR });
        console.log("PASS production browser: published reader/history and unchanged editor desktop/mobile/reduced-motion");
      }
      await stopServer(server);
      if (secure) {
        stage = "native 008 backup with comments, likes and restored privileged operations default-deny";
        const backupResult = await runPublicationBackupTests({
          source: application, controlURL: base, projectRoot: root, workspace,
          storage: { projectRoot: root, roots: { development: devRoot, test: storageRoot },
            environment: "test", maxVariantBytes: 4 * 1024 * 1024 },
          runtimeRole, maintenanceRole, key, first: httpResult.first, oldJar: httpResult.oldJar,
          origin, ca: tls.ca, secrets, rememberDatabase: name => databases.push(name),
          withRestoredServer: async (overrides, action) => {
            const restored = await startServer(port, { ...env, ...overrides }, servers, ingress);
            try { await action(); } finally { await stopServer(restored); }
          },
        });
        assert.equal(backupResult.passed, backupResult.total);
        console.log(`Publishing backup/restore: ${backupResult.passed}/${backupResult.total} checks passed`);
        stage = "production publishing management browser regression";
        const uiServer = await startServer(port, env, servers, ingress);
        try {
          const ui = await runPublishingEditorBrowser({ baseURL: origin, ...application, storageRoot,
            admin: httpResult.admin, regular: httpResult.regular, assets: httpResult.assets,
            privateValues: secrets,
            evidenceDirectory: process.env.PUBLISH_BROWSER_EVIDENCE_DIR });
          assert.equal(ui.passed, ui.total);
          console.log(`Publishing editor browser: ${ui.passed}/${ui.total} checks passed; ${ui.screenshots} screenshots`);
        } finally { await stopServer(uiServer); }
      }
      stage = "publishing disabled and missing signing key fail closed";
      for (const overrides of [{ MQ_PUBLISH_ENABLED: "false" }, { MQ_PUBLISH_SIGNING_KEY: "" }]) {
        const disabled = await startServer(port, { ...env, ...overrides }, servers, ingress);
        const response = await fetch(`http://127.0.0.1:${port}/api/admin/star-slots`, { headers: ingress });
        assert.equal(response.status, 503); await stopServer(disabled);
      }
      console.log("PASS publication-disabled and absent server key reject access");
      if (tls) { await tls.close(); tls = undefined; }
    }
    stage = "application output privacy";
    const logs = servers.map(server => server.output).join("\n");
    assert.ok(!logs.includes("@accounts.invalid")); assert.ok(!logs.includes("SYNTHETIC_PUBLISH_DATABASE_FAILURE"));
    for (const secret of secrets) assert.ok(!logs.includes(secret));
    console.log("PASS application output omits publication keys, account secrets and database details");
  } catch (error) { failure = error; }
  finally {
    for (const outcome of await Promise.allSettled(servers.map(stopServer))) if (outcome.status === "rejected") failure ??= outcome.reason;
    try { await tls?.close(); } catch (error) { failure ??= error; }
    for (const name of databases) { try { await control.query(`DROP DATABASE "${name}"`); } catch (error) { failure ??= error; } }
    for (const role of roles) { try { await control.query(`DROP ROLE "${role}"`); } catch (error) { failure ??= error; } }
    try { await control.end(); } catch (error) { failure ??= error; }
    if (workspace) try {
      const actual = await realpath(workspace), parent = await realpath(tmpdir());
      assert.equal(dirname(actual).toLowerCase(), parent.toLowerCase()); assert.ok(basename(actual).startsWith("mq-publishing-"));
      await rm(resolve(actual), { recursive: true, force: true });
    } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  console.log("PASS removed only owned temporary databases, roles, TLS and synthetic image files");
}
try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error.code ?? "") ? error.code : "ERROR";
  console.error(`Publishing integration FAILED at ${stage}${error.publishingStage ? ` / ${error.publishingStage}` : ""} (${code}; sensitive details withheld)`);
  process.exitCode = 1;
}
