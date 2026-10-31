import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import pg from "pg";
import { createDatabaseClient } from "../../src/lib/db/client.ts";
import { createPublicStoryReader } from "../../src/server/stories/public-service.ts";
import { databaseUrl } from "../db/environment.mjs";
import { runPrisma } from "../db/prisma-command.mjs";
import { configureTemporaryDatabaseLogging, verifyDatabaseLogging } from "../db/log-privacy.mjs";
import { createPublicFixtures } from "./fixtures.mjs";
import { runPublicReadChecks } from "./checks.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const next = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));
const { fetch, AbortSignal } = globalThis;
let stage = "validate public-story test instance";

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startServer(port, env, servers, expectedStatus = 200) {
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
    if (server.failed || server.exited) throw new Error("Test-owned public HTTP server stopped; output withheld");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/stories`, { signal: AbortSignal.timeout(1000) });
      if (response.status === expectedStatus) return server;
    } catch { /* Bounded startup, with child liveness checked each time. */ }
    await delay(250);
  }
  throw new Error("Test-owned public HTTP server readiness timed out; output withheld");
}

async function stopServer(server) {
  if (server.exited) return;
  const stopped = new Promise(resolve => server.child.once("exit", resolve));
  server.child.kill();
  await Promise.race([stopped, delay(5000)]);
  if (!server.exited) { server.child.kill("SIGKILL"); await Promise.race([stopped, delay(5000)]); }
  if (!server.exited) throw new Error("A test-owned public server could not stop");
}

async function main() {
  const base = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  const token = randomUUID().replaceAll("-", "");
  const name = `mq_test_public_${token}`;
  const role = `mq_public_ro_${token}`;
  assert.match(name, /^mq_test_public_[a-f0-9]{32}$/);
  assert.match(role, /^mq_public_ro_[a-f0-9]{32}$/);
  const ownerUrl = new URL(base);
  ownerUrl.pathname = `/${name}`;
  const password = randomBytes(32).toString("hex");
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  const mediaDirectory = new URL("../../public/story-media/", import.meta.url);
  const mediaFile = new URL(`public-test-${token}.webp`, mediaDirectory);
  const imageSource = `/story-media/public-test-${token}.webp`;
  const brokenImageSource = `/story-media/missing-test-${token}.webp`;
  let databaseCreated = false;
  let roleCreated = false;
  let directoryCreated = false;
  let mediaCreated = false;
  let client;
  let readClient;
  let owner;
  let readPool;
  let failure;
  let fixtures;
  const servers = [];
  try {
    const identity = (await control.query("SELECT current_database() AS db, current_user AS usr, current_setting('server_version_num') AS version")).rows[0];
    assert.equal(identity.db, "mq_test");
    assert.equal(identity.usr, "mq_test");
    assert.ok(Number(identity.version) >= 180000 && Number(identity.version) < 190000);
    console.log(`PostgreSQL server_version_num=${identity.version}`);
    await access(new URL("../../.next/BUILD_ID", import.meta.url));
    stage = "create this run's isolated database and restricted read identity";
    await control.query("SET log_statement='none'; SET log_min_error_statement='panic'; SET log_error_verbosity='terse'; SET log_parameter_max_length_on_error=0");
    await control.query(`CREATE ROLE "${role}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    roleCreated = true;
    await control.query(`CREATE DATABASE "${name}"`);
    databaseCreated = true;
    await configureTemporaryDatabaseLogging(control, name);
    owner = new pg.Pool({ connectionString: ownerUrl.href, max: 1, connectionTimeoutMillis: 5000 });
    await verifyDatabaseLogging(owner);
    stage = "apply all committed migrations to a genuinely empty database";
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
    await runPrisma(["migrate", "deploy"], ownerUrl.href);
    await runPrisma(["migrate", "status"], ownerUrl.href);
    await runPrisma(["migrate", "deploy"], ownerUrl.href);
    await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], ownerUrl.href);
    const expectedMigrations = (await readdir(new URL("../../prisma/migrations/", import.meta.url), { withFileTypes: true }))
      .filter(item => item.isDirectory()).map(item => item.name).sort();
    const history = (await owner.query("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name")).rows.map(row => row.migration_name);
    assert.deepEqual(history, expectedMigrations);
    console.log(`PASS empty PostgreSQL migrations: ${history.map(name => name.slice(8, 12)).join(" -> ")}; repeat deploy and schema drift match`);
    // Role grants affect only this generated database. No existing database,
    // role, table, shared cluster default, or P2-05 permission module is changed.
    await owner.query(`REVOKE CREATE,TEMPORARY ON DATABASE "${name}" FROM PUBLIC`);
    await owner.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    async function setDatabaseAvailable(available) {
      await owner.query(`${available ? "GRANT" : "REVOKE"} SELECT ON public.story,public.story_revision,public.star_slot ${available ? "TO" : "FROM"} "${role}"`);
    }
    await setDatabaseAvailable(true);
    client = createDatabaseClient(ownerUrl.href);
    readClient = createDatabaseClient(runtimeUrl.href);
    readPool = new pg.Pool({ connectionString: runtimeUrl.href, max: 1, connectionTimeoutMillis: 5000 });
    const emptyReader = createPublicStoryReader(readClient);
    assert.deepEqual(await emptyReader.listStories(), []);
    assert.equal(await emptyReader.getStory(randomUUID()), null);
    console.log("PASS genuinely empty public database returns no fabricated stories");
    stage = "prepare one test-owned static image and synthetic stories only in the isolated database";
    try { await mkdir(mediaDirectory); directoryCreated = true; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    // COPYFILE_EXCL (1) prevents replacing even an unexpected existing file.
    await copyFile(new URL("../../public/scene/night-sky.webp", import.meta.url), mediaFile, 1);
    mediaCreated = true;
    stage = "start a production HTTP worker using only the read identity";
    const port = await unusedPort();
    const baseURL = `http://127.0.0.1:${port}`;
    await startServer(port, { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: runtimeUrl.href, MQ_AUTH_ENABLED: "false" }, servers);
    const emptyHttp = await fetch(`${baseURL}/api/stories`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(emptyHttp.status, 200);
    assert.deepEqual(await emptyHttp.json(), { stories: [] });
    assert.match(emptyHttp.headers.get("cache-control") ?? "", /no-store/);
    console.log("PASS genuinely empty PostgreSQL database returns HTTP 200 with an empty catalog");
    stage = "insert this run's synthetic publication fixtures";
    const fixtureController = await createPublicFixtures(client, { imageSource, brokenImageSource });
    fixtures = fixtureController.fixtures;
    stage = "real PostgreSQL public content and HTTP response isolation";
    const result = await runPublicReadChecks({ client, readClient, readPool, baseURL,
      fixtureController, setDatabaseAvailable, runtimeRole: role });
    assert.equal(result.passed, result.total);
    console.log(`Public stories PostgreSQL/HTTP integration: ${result.passed}/${result.total} checks passed`);
    stage = "verify actual PostgreSQL connection refusal does not serve demo fallback";
    const failedUrl = new URL(runtimeUrl);
    failedUrl.port = String(await unusedPort());
    let failedPort = await unusedPort();
    while (failedPort === Number(failedUrl.port)) failedPort = await unusedPort();
    const failedServer = await startServer(failedPort, { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: failedUrl.href, MQ_AUTH_ENABLED: "false" }, servers, 503);
    for (const endpoint of ["/api/stories", `/api/stories/${fixtures.starOne.id}`]) {
      const response = await fetch(`http://127.0.0.1:${failedPort}${endpoint}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "PUBLIC_STORIES_UNAVAILABLE" });
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    }
    assert.ok(!failedServer.output.includes(failedUrl.href) && !failedServer.output.includes("ECONNREFUSED"));
    await stopServer(failedServer);
    console.log("PASS real PostgreSQL connection refusal returns redacted 503, distinct from an empty catalog");
    if (process.env.MQ_PUBLIC_BROWSER_MODULE) {
      stage = "real desktop/mobile public story browser regression";
      assert.ok(process.env.PUBLIC_BROWSER_EVIDENCE_DIR, "Browser evidence directory must be explicit");
      const { runBrowser } = await import(pathToFileURL(process.env.MQ_PUBLIC_BROWSER_MODULE).href);
      await runBrowser({ baseURL, evidenceDirectory: process.env.PUBLIC_BROWSER_EVIDENCE_DIR,
        fixtures, setDatabaseAvailable, setPublicVisible: fixtureController.setPublicVisible,
        withdrawStory: fixtureController.withdrawStory, restoreStory: fixtureController.restoreStory });
      console.log("PASS real public-story desktop/mobile browser regression");
    }
    stage = "verify captured application logs contain no credentials or private article data";
    const captured = servers.map(server => server.output).join("\n");
    for (const value of [base, ownerUrl.href, runtimeUrl.href, password, ...fixtures.privateCanaries]) {
      assert.ok(!captured.includes(value));
    }
    assert.ok(!captured.includes("@accounts.invalid"));
    assert.ok(!captured.includes("permission denied for table"));
    console.log("PASS captured production logs contain no database credential, private content or raw permission failure");
  } catch (error) { failure = error; }
  finally {
    // Teardown only exact resources created by this run. Never FORCE DROP,
    // terminate unrelated sessions, reset a DB, prune, or delete a Docker volume.
    for (const result of await Promise.allSettled(servers.map(stopServer))) if (result.status === "rejected") failure ??= result.reason;
    for (const result of await Promise.allSettled([client?.$disconnect(), readClient?.$disconnect(), owner?.end(), readPool?.end()])) {
      if (result.status === "rejected") failure ??= result.reason;
    }
    if (databaseCreated) try { await control.query(`DROP DATABASE "${name}"`); } catch (error) { failure ??= error; }
    if (roleCreated) try { await control.query(`DROP ROLE "${role}"`); } catch (error) { failure ??= error; }
    try { await control.end(); } catch (error) { failure ??= error; }
    if (mediaCreated) try { await rm(mediaFile); } catch (error) { failure ??= error; }
    if (directoryCreated) try { await rmdir(mediaDirectory); } catch (error) { if (error.code !== "ENOTEMPTY") failure ??= error; }
  }
  if (failure) throw failure;
  console.log("PASS removed only this run's temporary database, read identity, image and HTTP process");
}

try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error.code ?? "") ? error.code : "ERROR";
  console.error(`Public stories integration FAILED at: ${error.publicStage ?? stage} (${code}; raw responses/credentials withheld)`);
  process.exitCode = 1;
}
