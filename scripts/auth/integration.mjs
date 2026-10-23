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
import { runAuthHttpTests } from "./http-tests.mjs";
import { runHttpsChecks, startHttpsProxy } from "./https-proxy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const next = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));
const { fetch, AbortSignal } = globalThis;
let stage = "validate isolated authentication test target";

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function startServer(port, env, servers, headers = {}) {
  const child = spawn(process.execPath, [next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  // Keep child output only in memory for the secret-leak assertion. Never echo
  // raw framework/driver logs, including on startup or intentional DB failures.
  const server = { child, output: "", exited: false, failed: false };
  servers.push(server);
  child.stdout.on("data", (chunk) => { server.output += chunk; });
  child.stderr.on("data", (chunk) => { server.output += chunk; });
  child.once("error", () => { server.failed = true; });
  child.once("exit", () => { server.exited = true; });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.failed || server.exited) throw new Error("Authentication production server stopped unexpectedly (output withheld)");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/get-session`, { headers, signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch { /* Startup is bounded and child liveness is checked above. */ }
    await delay(250);
  }
  throw new Error("Authentication production server readiness timed out (output withheld)");
}

async function stopServer(server) {
  if (server.exited) return;
  const stopped = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill();
  await Promise.race([stopped, delay(5000)]);
  if (!server.exited) {
    server.child.kill("SIGKILL");
    await Promise.race([stopped, delay(5000)]);
  }
  if (!server.exited) throw new Error("A test-owned Next.js process could not stop");
}

async function main() {
  // The pre-existing test instance is only a control connection. No test ever
  // truncates mq_test, points to mq_development, or applies its migrations there.
  const baseUrl = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: baseUrl, max: 1, connectionTimeoutMillis: 5000 });
  const name = `mq_test_auth_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^mq_test_auth_[a-f0-9]{32}$/);
  const isolated = new URL(baseUrl);
  isolated.pathname = `/${name}`;
  let created = false;
  const servers = [];
  let tls;
  let failure;
  try {
    const identity = (await control.query("SELECT current_database() AS db, current_user AS usr, current_setting('server_version_num') AS version")).rows[0];
    assert.equal(identity.db, "mq_test");
    assert.equal(identity.usr, "mq_test");
    assert.ok(Number(identity.version) >= 180000 && Number(identity.version) < 190000);
    console.log(`PostgreSQL server_version_num=${identity.version}`);
    await access(new URL("../../.next/BUILD_ID", import.meta.url));
    stage = "create an empty test-owned authentication database";
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await configureTemporaryDatabaseLogging(control, name);
    stage = "apply every committed migration to an empty database";
    await runPrisma(["migrate", "deploy"], isolated.href);
    await runPrisma(["migrate", "status"], isolated.href);
    await runPrisma(["migrate", "deploy"], isolated.href);
    await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], isolated.href);
    console.log("PASS fresh database migrations, repeat deployment and schema drift check");
    const port = await unusedPort();
    let secondPort = await unusedPort();
    while (secondPort === port) secondPort = await unusedPort();
    const origin = `http://127.0.0.1:${port}`;
    const secondOrigin = `http://127.0.0.1:${secondPort}`;
    const secret = randomBytes(48).toString("base64url");
    const env = {
      ...process.env,
      NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1",
      DATABASE_URL: isolated.href, MQ_AUTH_ENABLED: "true",
      AUTH_SECRET: secret, AUTH_ORIGIN: origin, AUTH_ALLOW_LOCAL_HTTP: "true", AUTH_PROXY_SECRET: "",
    };
    stage = "start two production Next.js processes against the isolated database";
    await startServer(port, env, servers);
    await startServer(secondPort, env, servers);
    stage = "real PostgreSQL authentication HTTP integration";
    const results = await runAuthHttpTests({ connectionString: isolated.href, origin, secondOrigin });
    console.log(`Authentication HTTP integration: ${results.passed}/${results.total} checks passed`);
    if (results.passed !== results.total) throw new Error("One or more authentication integration assertions failed");
    // Release the HTTP workers before the TLS/browser phase to bound memory.
    await Promise.all(servers.map(stopServer));
    stage = "start test-owned TLS ingress with authenticated proxy headers";
    const tlsBackendPort = await unusedPort();
    tls = await startHttpsProxy(tlsBackendPort);
    results.secrets.push(tls.proxySecret);
    await startServer(tlsBackendPort, {
      ...env, AUTH_ORIGIN: tls.origin, AUTH_ALLOW_LOCAL_HTTP: "false", AUTH_PROXY_SECRET: tls.proxySecret,
    }, servers, { "x-mq-proxy-key": tls.proxySecret, "x-mq-client-ip": "127.0.0.1" });
    stage = "certificate-verified HTTPS and authenticated proxy integration";
    const secure = await runHttpsChecks({
      origin: tls.origin, ca: tls.ca, backendOrigin: `http://127.0.0.1:${tlsBackendPort}`, connectionString: isolated.href,
    });
    results.secrets.push(...secure.secrets);
    console.log(`Authentication HTTPS integration: ${secure.passed}/${secure.total} checks passed`);
    // An optional local browser harness uses the same disposable database and
    // server. Its path and evidence directory are explicit; CI HTTP verification
    // never depends on an uncommitted helper or installs another browser runtime.
    if (process.env.MQ_AUTH_BROWSER_MODULE) {
      stage = "real browser authentication regression";
      if (!process.env.AUTH_BROWSER_EVIDENCE_DIR) throw new Error("Browser evidence directory must be explicit");
      const { runBrowser } = await import(pathToFileURL(process.env.MQ_AUTH_BROWSER_MODULE).href);
      const browserPassword = `MqBrowser!${randomBytes(24).toString("base64url")}`;
      results.secrets.push(browserPassword);
      await runBrowser({
        baseURL: tls.origin, evidenceDirectory: process.env.AUTH_BROWSER_EVIDENCE_DIR,
        password: browserPassword, usernamePrefix: `mq_${randomBytes(4).toString("hex")}`,
        ignoreHTTPSErrors: true, expectedSecure: true,
      });
      console.log("PASS real browser authentication regression");
    }
    const inspection = new pg.Pool({ connectionString: isolated.href, max: 1 });
    try {
      const rows = (await inspection.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
      results.secrets.push(...rows.map((row) => row.value));
    } finally { await inspection.end(); }
    stage = "assert production logs do not disclose synthetic secrets";
    const output = servers.map((server) => server.output).join("\n");
    assert.ok(!output.includes(secret) && !output.includes(isolated.href), "Server logs must not disclose authentication or connection secrets");
    assert.ok(results.secrets.every((value) => !output.includes(value)), "Server logs must not disclose internal email, password or raw session token");
    assert.ok(!output.includes("@accounts.invalid"), "Even rolled-back synthetic internal emails must not reach production logs");
    console.log("PASS captured production logs contain no synthetic secret/email/session token");
  } catch (error) {
    failure = error;
  } finally {
    const auditCategories = ["MQ_AUTH_CONFIG_UNAVAILABLE", "MQ_AUTH_LIMITER_FAILURE", "MQ_AUTH_HASH_BUSY",
      "MQ_AUTH_STORAGE_UNAVAILABLE", "MQ_AUTH_INTERNAL_ERROR", "MQ_AUTH_TRANSACTION_ERROR", "MQ_AUTH_FRAMEWORK_ERROR"];
    const captured = servers.map(server => server.output).join("\n");
    console.log("Authentication fixed-category audit: " + JSON.stringify(Object.fromEntries(auditCategories
      .map(category => [category, captured.split(category).length - 1]).filter(([, count]) => count > 0))));
    // End processes before dropping only the database created by this exact run.
    // Never FORCE DROP, kill someone else's sessions, or remove Docker volumes.
    for (const result of await Promise.allSettled(servers.map(stopServer))) {
      if (result.status === "rejected") failure ??= result.reason;
    }
    try { await tls?.close(); } catch (error) { failure ??= error; }
    if (created) {
      try { await control.query(`DROP DATABASE "${name}"`); }
      catch (error) { failure ??= error; }
    }
    try { await control.end(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  console.log("PASS stopped only test-owned processes and removed only this run's temporary database");
}

try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error.code ?? "") ? error.code : "ERROR";
  console.error(`Authentication integration FAILED at: ${stage} (${code}). Connection details and raw responses omitted.`);
  process.exitCode = 1;
}
