import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import pg from "pg";
import { databaseUrl } from "../db/environment.mjs";
import { runPrisma } from "../db/prisma-command.mjs";
import { configureTemporaryDatabaseLogging, verifyDatabaseLogging } from "../db/log-privacy.mjs";
import { applyAdminDatabasePrivileges } from "../admin/privileges.mjs";
import { applyAdminDraftDatabasePrivileges } from "../admin-drafts/privileges.mjs";
import { startHttpsProxy } from "../auth/https-proxy.mjs";
import { applyMediaDatabasePrivileges } from "./privileges.mjs";
import { runMediaPrivilegeTests } from "./privileges-tests.mjs";
import { runMediaRecoveryTests } from "./recovery-tests.mjs";
import { runCombinedMediaDraftPrivilegeTests } from "./combined-privileges-tests.mjs";
import { runMediaUploadHttpTests, runMediaUploadHttpsTests } from "./upload-http-tests.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const next = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));
const { fetch } = globalThis;
let stage = "validate isolated PostgreSQL target";

async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  return address.port;
}

async function startServer(port, env, servers, headers = {}) {
  const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const server = { child, output: "", exited: false, failed: false }; servers.push(server);
  child.stdout.on("data", chunk => { server.output += chunk; }); child.stderr.on("data", chunk => { server.output += chunk; });
  child.once("error", () => { server.failed = true; }); child.once("exit", () => { server.exited = true; });
  for (let n = 0; n < 120; n++) {
    if (server.failed || server.exited) throw new Error("MEDIA_TEST_SERVER_STOPPED");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/get-session`, { headers, signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return server;
    } catch { /* Bounded startup polling for this test-owned process only. */ }
    await delay(250);
  }
  throw new Error("MEDIA_TEST_SERVER_NOT_READY");
}

async function stopServer(server, force = false) {
  if (server.exited) return;
  const stopped = new Promise(done => server.child.once("exit", done));
  server.child.kill(force ? "SIGKILL" : "SIGTERM");
  await Promise.race([stopped, delay(5000)]);
  if (!server.exited) { server.child.kill("SIGKILL"); await Promise.race([stopped, delay(5000)]); }
  if (!server.exited) throw new Error("MEDIA_TEST_SERVER_WILL_NOT_STOP");
}

async function main() {
  const base = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  const suffix = randomUUID().replaceAll("-", "");
  const runtimeRole = `mq_admin_rt_${suffix}`, maintenanceRole = `mq_admin_mt_${suffix}`;
  const mediaMaintenanceRole = `mq_media_mt_${suffix}`;
  const rolePasswords = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  if (process.env.MQ_MEDIA_LIFECYCLE_TESTS === "true") rolePasswords.push(randomBytes(32).toString("hex"));
  const roles = [], databases = [], servers = [], secrets = new Set(rolePasswords);
  let workspace, tls, failure;
  async function isolatedDatabase({ drafts = false } = {}) {
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
      assert.deepEqual(migrations, ["202610230001_database_foundation", "202610230002_story_lifecycle", "202610230003_username_auth", "202610250004_admin_authorization", "202611030005_media_foundation", "202611040006_story_publication", "202611040007_story_likes", "202611050008_story_comments"]);
      const configure = drafts ? applyAdminDraftDatabasePrivileges : applyAdminDatabasePrivileges;
      await configure(owner, { runtimeRole, maintenanceRole, expectedDatabase: name });
      await applyMediaDatabasePrivileges(owner, { runtimeRole, expectedDatabase: name });
      await owner.query(`GRANT SELECT ON public.story_like,public.story_comment TO "${runtimeRole}"`);
    } finally { await owner.end(); }
    const runtime = new URL(ownerUrl); runtime.username = runtimeRole; runtime.password = rolePasswords[0];
    const maintenance = new URL(ownerUrl); maintenance.username = maintenanceRole; maintenance.password = rolePasswords[1];
    return { connectionString: ownerUrl.href, runtimeUrl: runtime.href, maintenanceUrl: maintenance.href, name };
  }
  try {
    const info = (await control.query("SELECT current_database() AS db,current_user AS usr,current_setting('server_version_num') AS version")).rows[0];
    assert.equal(info.db, "mq_test"); assert.equal(info.usr, "mq_test"); assert.ok(Number(info.version) >= 180000 && Number(info.version) < 190000);
    console.log(`PostgreSQL server_version_num=${info.version}`);
    await access(new URL("../../.next/BUILD_ID", import.meta.url));
    stage = "create only this run's restricted roles";
    await control.query("SET log_statement='none'; SET log_min_error_statement='panic'; SET log_error_verbosity='terse'; SET log_parameter_max_length_on_error=0");
    const testRoles = [runtimeRole, maintenanceRole];
    if (process.env.MQ_MEDIA_LIFECYCLE_TESTS === "true") testRoles.push(mediaMaintenanceRole);
    for (const [index, role] of testRoles.entries()) {
      assert.match(role, /^mq_(admin_(rt|mt)|media_mt)_[a-f0-9]{32}$/); assert.match(rolePasswords[index], /^[a-f0-9]{64}$/);
      await control.query(`CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${rolePasswords[index]}'`); roles.push(role);
    }
    stage = "isolated empty migrations and exact media privilege matrix";
    const domain = await isolatedDatabase();
    const owner = new pg.Pool({ connectionString: domain.connectionString, max: 2 }), runtime = new pg.Pool({ connectionString: domain.runtimeUrl, max: 2 });
    try {
      const result = await runMediaPrivilegeTests({ owner, runtime, runtimeRole, expectedDatabase: domain.name });
      assert.equal(result.passed, result.total); console.log(`Media database privileges: ${result.passed}/${result.total} checks passed`);
    } finally { await Promise.allSettled([owner.end(), runtime.end()]); }
    stage = "real in-flight finalization commit and rollback recovery races";
    const recovery = await runMediaRecoveryTests(domain);
    assert.equal(recovery.passed, recovery.total); console.log(`Media database recovery races: ${recovery.passed}/${recovery.total} checks passed`);
    stage = "separate HTTP database and private test filesystem";
    const application = await isolatedDatabase({ drafts: true });
    const combinedRuntime = new pg.Pool({ connectionString: application.runtimeUrl, max: 1 });
    try {
      const combined = await runCombinedMediaDraftPrivilegeTests({ runtime: combinedRuntime, runtimeRole, expectedDatabase: application.name });
      assert.equal(combined.passed, combined.total);
      console.log(`Combined draft/media database privileges: ${combined.passed}/${combined.total} checks passed`);
    } finally { await combinedRuntime.end(); }
    console.log("PASS two independent databases apply 001 -> 008, repeated deploy, schema drift and private error logging");
    workspace = await mkdtemp(join(tmpdir(), "mq-media-upload-"));
    const devRoot = join(workspace, "private-development"), testRoot = join(workspace, "private-test");
    await mkdir(devRoot, { mode: 0o700 }); await mkdir(testRoot, { mode: 0o700 });
    const port = await unusedPort(), origin = `http://127.0.0.1:${port}`, secret = randomBytes(48).toString("base64url");
    secrets.add(secret); secrets.add(workspace);
    const env = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: application.runtimeUrl,
      MQ_AUTH_ENABLED: "true", AUTH_SECRET: secret, AUTH_ORIGIN: origin, AUTH_ALLOW_LOCAL_HTTP: "true", AUTH_PROXY_SECRET: "",
      MQ_MEDIA_ENABLED: "true", MQ_MEDIA_ENV: "test", MQ_MEDIA_DEVELOPMENT_ROOT: devRoot, MQ_MEDIA_TEST_ROOT: testRoot };
    stage = "production HTTP media upload, private access, failures and real server crash recovery";
    let plain = await startServer(port, env, servers);
    const httpResult = await runMediaUploadHttpTests({ ...application, runtimeRole, origin, storageRoot: testRoot,
      async restartServer() { await stopServer(plain, true); plain = await startServer(port, env, servers); },
    });
    httpResult.secrets.forEach(value => secrets.add(value));
    console.log(`Media upload HTTP integration: ${httpResult.passed}/${httpResult.total} checks passed`);
    assert.equal(httpResult.passed, httpResult.total); await stopServer(plain);
    stage = "certificate-verified TLS and private cookie/cache boundaries";
    const backendPort = await unusedPort(); tls = await startHttpsProxy(backendPort); secrets.add(tls.proxySecret);
    const secure = await startServer(backendPort, { ...env, AUTH_ORIGIN: tls.origin, AUTH_ALLOW_LOCAL_HTTP: "false", AUTH_PROXY_SECRET: tls.proxySecret }, servers,
      { "x-mq-proxy-key": tls.proxySecret, "x-mq-client-ip": "127.0.0.1" });
    const tlsResult = await runMediaUploadHttpsTests({ origin: tls.origin, ca: tls.ca,
      backendOrigin: `http://127.0.0.1:${backendPort}`, credentials: httpResult, secrets });
    assert.equal(tlsResult.passed, tlsResult.total); console.log(`Media upload HTTPS integration: ${tlsResult.passed}/${tlsResult.total} checks passed`);
    if (process.env.MQ_MEDIA_STORY_TESTS === "true") {
      stage = "third isolated database for managed story images and private editor integration";
      const stories = await isolatedDatabase({ drafts: true });
      const storyRoot = join(workspace, "private-story-images"); await mkdir(storyRoot, { mode: 0o700 });
      await stopServer(secure);
      await startServer(backendPort, { ...env, DATABASE_URL: stories.runtimeUrl, MQ_MEDIA_TEST_ROOT: storyRoot,
        AUTH_ORIGIN: tls.origin, AUTH_ALLOW_LOCAL_HTTP: "false", AUTH_PROXY_SECRET: tls.proxySecret }, servers,
        { "x-mq-proxy-key": tls.proxySecret, "x-mq-client-ip": "127.0.0.1" });
      const { runMediaStoryHttpTests } = await import("./story-http-tests.mjs");
      let runBrowser;
      if (process.env.MQ_MEDIA_STORY_BROWSER_MODULE) {
        assert.ok(process.env.MEDIA_STORY_EVIDENCE_DIR);
        ({ runBrowser } = await import(pathToFileURL(process.env.MQ_MEDIA_STORY_BROWSER_MODULE).href));
        assert.equal(typeof runBrowser, "function");
      }
      const result = await runMediaStoryHttpTests({ ...stories, runtimeRole, origin: tls.origin, ca: tls.ca,
        storageRoot: storyRoot, runBrowser, evidenceDirectory: process.env.MEDIA_STORY_EVIDENCE_DIR });
      assert.equal(result.passed, result.total); console.log(`Managed story media integration: ${result.passed}/${result.total} checks passed`);
      [...result.secrets, ...result.privateCanaries, stories.connectionString, stories.runtimeUrl, storyRoot].forEach(value => secrets.add(value));
    }
    if (process.env.MQ_MEDIA_LIFECYCLE_TESTS === "true") {
      stage = "isolated media deletion and recovery";
      await stopServer(secure);
      const lifecycle = await isolatedDatabase({ drafts: true });
      const lifecycleRoot = join(workspace, "private-lifecycle"); await mkdir(lifecycleRoot, { mode: 0o700 });
      const { applyMediaMaintenancePrivileges } = await import("./maintenance-privileges.mjs");
      stage = "dedicated media maintenance privilege matrix";
      const provision = new pg.Pool({ connectionString: lifecycle.connectionString, max: 1 });
      try { await applyMediaMaintenancePrivileges(provision, { maintenanceRole: mediaMaintenanceRole, expectedDatabase: lifecycle.name }); }
      finally { await provision.end(); }
      const mediaMaintenanceUrl = new URL(lifecycle.connectionString);
      mediaMaintenanceUrl.username = mediaMaintenanceRole; mediaMaintenanceUrl.password = rolePasswords[2];
      const { runMediaLifecycleDatabaseTests } = await import("./lifecycle-tests.mjs");
      stage = "media deletion and reference database ordering";
      const dbResult = await runMediaLifecycleDatabaseTests(lifecycle);
      assert.equal(dbResult.passed, dbResult.total);
      console.log(`Media lifecycle PostgreSQL: ${dbResult.passed}/${dbResult.total} checks passed`);
      const { runMediaLifecycleMaintenanceTests } = await import("./lifecycle-maintenance-tests.mjs");
      stage = "offline media diagnostics and recovery";
      const maintenanceResult = await runMediaLifecycleMaintenanceTests({ connectionString: lifecycle.connectionString,
        maintenanceUrl: mediaMaintenanceUrl.href, storageRoot: lifecycleRoot, projectRoot: root });
      assert.equal(maintenanceResult.passed, maintenanceResult.total);
      console.log(`Media offline maintenance: ${maintenanceResult.passed}/${maintenanceResult.total} checks passed`);
      const lifecycleEnv = { ...env, DATABASE_URL: lifecycle.runtimeUrl, MQ_MEDIA_TEST_ROOT: lifecycleRoot,
        AUTH_ORIGIN: tls.origin, AUTH_ALLOW_LOCAL_HTTP: "false", AUTH_PROXY_SECRET: tls.proxySecret };
      const probeHeaders = { "x-mq-proxy-key": tls.proxySecret, "x-mq-client-ip": "127.0.0.1" };
      let lifecycleServer = await startServer(backendPort, lifecycleEnv, servers, probeHeaders);
      const { runMediaLifecycleHttpTests } = await import("./lifecycle-http-tests.mjs");
      stage = "confirmed media deletion over production HTTPS";
      const deletion = await runMediaLifecycleHttpTests({ ...lifecycle, runtimeRole, origin: tls.origin, ca: tls.ca,
        storageRoot: lifecycleRoot, async restartServer() {
          await stopServer(lifecycleServer, true);
          lifecycleServer = await startServer(backendPort, lifecycleEnv, servers, probeHeaders);
        } });
      assert.equal(deletion.passed, deletion.total);
      deletion.secrets.forEach(value => secrets.add(value));
      console.log(`Media lifecycle HTTPS: ${deletion.passed}/${deletion.total} checks passed`);
      await stopServer(lifecycleServer);
      stage = "joint PostgreSQL and private-file backup and isolated restore";
      const { runBackupTests } = await import("./backup-tests.mjs");
      const restoredTests = await runBackupTests({ controlURL: base, projectRoot: root,
        async verifyRestored({ databaseURL, privateRoot, publicStoryId, publicAssetId, privateAssetId,
          expectedPublicBytes, expectedPrivateBytes, admin: restoredAdmin }) {
          secrets.add(restoredAdmin.password); secrets.add(privateRoot);
          const database = new URL(databaseURL).pathname.slice(1);
          const owner = new pg.Pool({ connectionString: databaseURL, max: 1 });
          try {
            await applyAdminDatabasePrivileges(owner, { runtimeRole, maintenanceRole, expectedDatabase: database });
            await applyMediaDatabasePrivileges(owner, { runtimeRole, expectedDatabase: database });
            await owner.query(`GRANT SELECT ON public.story_like,public.story_comment TO "${runtimeRole}"`);
          } finally { await owner.end(); }
          const restoredRuntime = new URL(databaseURL); restoredRuntime.username = runtimeRole; restoredRuntime.password = rolePasswords[0];
          const restoredServer = await startServer(backendPort, { ...lifecycleEnv, DATABASE_URL: restoredRuntime.href,
            MQ_MEDIA_TEST_ROOT: privateRoot }, servers, probeHeaders);
          try {
            const { transport, privateHeaders } = await import("./upload-http-tests.mjs");
            const { request } = transport(tls.origin, secrets, tls.ca);
            for (const method of ["GET", "HEAD"]) {
              const visible = await request(`/api/stories/${publicStoryId}/media/${publicAssetId}`, { method });
              assert.equal(visible.status, 200); privateHeaders(visible);
              if (method === "GET") assert.deepEqual(visible.bytes, expectedPublicBytes);
              const hidden = await request(`/api/stories/${publicStoryId}/media/${privateAssetId}`, { method });
              assert.equal(hidden.status, 404); privateHeaders(hidden);
              const admin = await request(`/api/admin/media/${privateAssetId}/content`, { method });
              assert.equal(admin.status, 401); privateHeaders(admin);
            }
            const jar = {};
            const login = await request("/api/auth/sign-in/username", { method: "POST", body: restoredAdmin, jar });
            assert.equal(login.status, 200); assert.ok(jar.cookie);
            for (const method of ["GET", "HEAD"]) {
              const privateImage = await request(`/api/admin/media/${privateAssetId}/content`, { method, jar });
              assert.equal(privateImage.status, 200); privateHeaders(privateImage);
              if (method === "GET") assert.deepEqual(privateImage.bytes, expectedPrivateBytes);
            }
            const inspect = new pg.Pool({ connectionString: databaseURL, max: 1 });
            try {
              const values = (await inspect.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL UNION ALL SELECT storage_key::text AS value FROM media_asset')).rows;
              values.forEach(row => secrets.add(row.value));
            } finally { await inspect.end(); }
            console.log("PASS restored production HTTPS preserves public/private image boundaries");
          } finally { await stopServer(restoredServer); }
        } });
      assert.equal(restoredTests.passed, restoredTests.total);
      console.log(`Media backup/restore: ${restoredTests.passed}/${restoredTests.total} checks passed`);
    }
    stage = "production logs contain no synthetic sensitive values or private storage identity";
    const inspect = new pg.Pool({ connectionString: application.connectionString, max: 1 });
    try {
      const rows = (await inspect.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL UNION ALL SELECT storage_key::text AS value FROM media_asset')).rows;
      rows.forEach(row => secrets.add(row.value));
    } finally { await inspect.end(); }
    const logs = servers.map(server => server.output).join("\n");
    assert.ok(!logs.includes("@accounts.invalid"));
    assert.ok([...secrets].every(value => !logs.includes(value)));
    assert.ok(!logs.includes(application.connectionString) && !logs.includes(application.runtimeUrl));
    console.log("PASS application logs contain no synthetic secret, session, internal email or private storage identity");
  } catch (error) { failure = error; }
  finally {
    for (const result of await Promise.allSettled(servers.map(server => stopServer(server)))) if (result.status === "rejected") failure ??= result.reason;
    try { await tls?.close(); } catch (error) { failure ??= error; }
    for (const name of databases) { try { await control.query(`DROP DATABASE "${name}"`); } catch (error) { failure ??= error; } }
    for (const role of roles) { try { await control.query(`DROP ROLE "${role}"`); } catch (error) { failure ??= error; } }
    try { await control.end(); } catch (error) { failure ??= error; }
    if (workspace) {
      try {
        const actual = await realpath(workspace), parent = await realpath(tmpdir());
        assert.equal(dirname(actual), parent); assert.equal(actual, resolve(workspace)); assert.ok(basename(actual).startsWith("mq-media-upload-"));
        await rm(actual, { recursive: true, force: false });
      } catch (error) { failure ??= error; }
    }
  }
  if (failure) throw failure;
  console.log("PASS removed only this run's temporary databases, roles, private images, TLS and server processes");
}

try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR";
  console.error(`Media upload integration FAILED at: ${error.stage ?? stage} (${code}; raw details withheld)`);
  process.exitCode = 1;
}
