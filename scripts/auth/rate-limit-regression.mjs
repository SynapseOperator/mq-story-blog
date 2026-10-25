import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createDatabaseClient } from "../../src/lib/db/client.ts";
import { databaseUrl } from "../db/environment.mjs";
import { configureTemporaryDatabaseLogging } from "../db/log-privacy.mjs";
import { runPrisma } from "../db/prisma-command.mjs";

const { fetch } = globalThis;
const nativeOnly = process.argv.includes("--native-only");
const customOnly = process.argv.includes("--custom-only");
const report = {
  betterAuth: "1.7.12", platform: process.platform, node: process.version,
  purpose: "Real loopback HTTP / PostgreSQL cold-key contention, without any password hashing or user data",
  scope: customOnly ? "custom-only" : nativeOnly ? "native-only" : "native-and-custom",
  interpretation: "Legacy unique collisions are caught/retried by Better Auth; reproducing them does not establish the cause of historical HTTP 503 responses",
  cases: [], cleanup: false,
};
let stage = "validate isolated database";

// Errors are observed at the public Prisma extension point, before Better Auth
// can catch/retry them. Store only classifications; never Error/message/row data.
function observeClient(client, counts, diagnostics) {
  return client.$extends({ query: { $allOperations: async ({ args, query }) => {
    try { return await query(args); }
    catch (error) {
      const code = /^[A-Z0-9_]{1,20}$/.test(error.code ?? "") ? error.code : "UNKNOWN";
      counts[code] = (counts[code] ?? 0) + 1;
      // Inspect metadata in memory, but persist only literal allowlisted facts.
      // Prisma can include synthetic limiter keys in its message and metadata.
      const metadata = JSON.stringify(error.meta ?? {});
      if (metadata.includes('"23505"')) diagnostics.sqlstate23505 += 1;
      if (metadata.includes("RateLimit_key_key")) diagnostics.namedKeyConstraint += 1;
      throw error;
    }
  } } });
}

async function serve(client, mode, customStorage, max, counts, secret) {
  let auth;
  const server = createServer(async (incoming, outgoing) => {
    // This diagnostic server exposes only a read-only, cookie-free session GET.
    if (incoming.method !== "GET" || incoming.url !== "/api/auth/get-session") {
      outgoing.writeHead(404).end();
      return;
    }
    try {
      const response = await auth.handler(new Request(`${origin}${incoming.url}`, {
        headers: { origin },
      }));
      outgoing.writeHead(response.status, { "content-type": "application/json",
        ...(response.headers.has("x-retry-after") ? { "x-retry-after": response.headers.get("x-retry-after") } : {}) });
      outgoing.end(await response.text());
    } catch (error) {
      const code = /^[A-Z0-9_]{1,20}$/.test(error.code ?? "") ? error.code : "UNKNOWN";
      counts.httpErrors[code] = (counts.httpErrors[code] ?? 0) + 1;
      outgoing.writeHead(503, { "content-type": "application/json" }).end('{"code":"DIAGNOSTIC_INTERNAL_ERROR"}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  auth = betterAuth({
    baseURL: origin, secret, trustedOrigins: [origin],
    database: prismaAdapter(client, { provider: "postgresql", transaction: true }),
    logger: { level: "error", log: () => { counts.frameworkErrors += 1; } },
    onAPIError: { throw: true },
    advanced: { ipAddress: { ipAddressHeaders: [] } },
    emailAndPassword: { enabled: true, password: {
      hash: async () => { counts.hashCalls += 1; throw new Error("Hashing is outside this no-credentials regression"); },
      verify: async () => { counts.hashCalls += 1; throw new Error("Hashing is outside this no-credentials regression"); },
    } },
    rateLimit: { enabled: true, storage: "database", window: 60, max,
      customRules: { "/get-session": { window: 60, max } },
      ...(mode === "custom" ? { customStorage } : {}),
    },
  });
  return { origin, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function waitForBlocked(pool, lock, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = (await pool.query(`SELECT count(*)::int AS count FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.datname = current_database() AND l.locktype = 'advisory'
      AND l.classid = 0 AND l.objid = $1 AND NOT l.granted`, [lock])).rows[0];
    if (row.count === expected) return;
    await delay(25);
  }
  throw new Error("Concurrent requests did not all reach the database barrier");
}

async function runCase(pool, connectionString, mode, customStorageFactory, max, rounds = 1) {
  const errors = {};
  const diagnostics = { sqlstate23505: 0, namedKeyConstraint: 0 };
  const counts = { httpErrors: {}, frameworkErrors: 0, hashCalls: 0 };
  const clients = [createDatabaseClient(connectionString), createDatabaseClient(connectionString)];
  const lock = 1_000_000 + randomBytes(3).readUIntBE(0, 3);
  const secret = randomBytes(48).toString("base64url");
  const servers = [];
  const observed = { mode, max, rounds, statuses: {}, prismaErrors: errors, diagnostics, httpErrors: counts.httpErrors,
    hashCalls: 0, rowCounts: [], barrierTable: "RateLimit", barrierRequestsPerRound: 4 };
  let barrierConnection;
  let pending = [];
  try {
    await pool.query(`CREATE FUNCTION mq_rate_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock_shared(${lock}); RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER mq_rate_barrier BEFORE INSERT ON "RateLimit" FOR EACH ROW EXECUTE FUNCTION mq_rate_barrier()');
    for (const client of clients) {
      const observedClient = observeClient(client, errors, diagnostics);
      const customStorage = mode === "custom" ? customStorageFactory(observedClient, secret) : undefined;
      servers.push(await serve(observedClient, mode, customStorage, max, counts, secret));
    }
    for (let round = 0; round < rounds; round += 1) {
      await pool.query('DELETE FROM "RateLimit"');
      barrierConnection = await pool.connect();
      await barrierConnection.query("SELECT pg_advisory_lock($1)", [lock]);
      pending = Array.from({ length: 4 }, async (_, index) => {
        const response = await fetch(`${servers[index % servers.length].origin}/api/auth/get-session`, { signal: AbortSignal.timeout(20_000) });
        const body = await response.json();
        assert.ok(body === null || response.status === 429 || response.status === 503, "No-credentials GET must never expose user/session data");
        if (response.status === 429) assert.match(response.headers.get("x-retry-after") ?? "", /^[1-9][0-9]*$/, "A quota rejection must include the framework retry interval");
        return response.status;
      });
      // Database synchronization proves four absent-key requests reached INSERT
      // together. This is not probabilistic sleep-based load or a mocked DB.
      await waitForBlocked(pool, lock, 4);
      await barrierConnection.query("SELECT pg_advisory_unlock($1)", [lock]);
      barrierConnection.release();
      barrierConnection = undefined;
      const statuses = await Promise.all(pending);
      pending = [];
      for (const status of statuses) observed.statuses[status] = (observed.statuses[status] ?? 0) + 1;
      const rows = (await pool.query('SELECT count FROM "RateLimit"')).rows;
      assert.equal(rows.length, 1, "One stable limiter key must remain");
      observed.rowCounts.push(rows[0].count);
      assert.equal(statuses.filter(value => value === 200).length, Math.min(max, 4), "No below-quota GET may fail due to limiter contention");
      assert.equal(statuses.filter(value => value === 429).length, Math.max(0, 4 - max), "Only the configured quota may reject a GET");
      assert.equal(rows[0].count, Math.min(max, 4), "Counter must equal admitted requests, without lost increments");
    }
    if (max === 2) {
      // Time is changed only on this run's limiter row; no waiting, auth records,
      // system clock or PostgreSQL global configuration are modified.
      await pool.query('UPDATE "RateLimit" SET "lastRequest" = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - 61000');
      const reset = await fetch(`${servers[0].origin}/api/auth/get-session`);
      assert.equal(reset.status, 200, "Expired framework window must admit the next request");
      await reset.arrayBuffer();
      assert.equal((await pool.query('SELECT count FROM "RateLimit"')).rows[0].count, 1, "Expired counter must reset to one");
      const hot = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
        const response = await fetch(`${servers[index % servers.length].origin}/api/auth/get-session`);
        await response.arrayBuffer();
        return response.status;
      }));
      assert.deepEqual(hot.sort(), [200, 429, 429, 429], "Competing increments on an existing row must admit exactly the remaining quota");
      const beforeReject = (await pool.query('SELECT count, "lastRequest" FROM "RateLimit"')).rows[0];
      const rejected = await fetch(`${servers[1].origin}/api/auth/get-session`);
      assert.equal(rejected.status, 429);
      await rejected.arrayBuffer();
      const afterReject = (await pool.query('SELECT count, "lastRequest" FROM "RateLimit"')).rows[0];
      assert.deepEqual(afterReject, beforeReject, "A blocked request must not increase count or prolong the accepted-request window");
      observed.expiryReset = true;
      observed.hotStatuses = { 200: 1, 429: 3 };
      observed.rejectedRowUnchanged = true;
    }
    observed.hashCalls = counts.hashCalls;
    assert.equal(counts.hashCalls, 0, "No password operation may occur in this limiter reproduction");
    assert.deepEqual(counts.httpErrors, {}, "No framework error may be disguised as password capacity rejection");
    if (mode === "native") {
      assert.equal(errors.P2002, rounds * 3, "The original native storage must reproduce three caught unique collisions per cold key");
      assert.equal(diagnostics.sqlstate23505, rounds * 3, "Original metadata must confirm PostgreSQL unique violations");
      assert.equal(diagnostics.namedKeyConstraint, rounds * 3, "Original metadata must identify RateLimit_key_key specifically");
    } else assert.deepEqual(errors, {}, "Atomic custom storage must have no unique collisions or other Prisma errors");
    return observed;
  } finally {
    if (barrierConnection) {
      await barrierConnection.query("SELECT pg_advisory_unlock($1)", [lock]);
      barrierConnection.release();
    }
    await Promise.allSettled(pending);
    for (const server of servers) await server.close();
    for (const client of clients) await client.$disconnect();
    await pool.query('DROP TRIGGER IF EXISTS mq_rate_barrier ON "RateLimit"');
    await pool.query("DROP FUNCTION IF EXISTS mq_rate_barrier()");
  }
}

async function main() {
  assert.ok(!(nativeOnly && customOnly), "Choose only one storage-only mode");
  const base = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  const name = `mq_test_auth_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^mq_test_auth_[a-f0-9]{32}$/);
  const url = new URL(base);
  url.pathname = `/${name}`;
  let created = false;
  let pool;
  try {
    const identity = (await control.query("SELECT current_database() AS db, current_user AS usr, current_setting('server_version_num') AS version")).rows[0];
    assert.equal(identity.db, "mq_test");
    assert.equal(identity.usr, "mq_test");
    assert.ok(Number(identity.version) >= 180000 && Number(identity.version) < 190000);
    report.postgresVersion = identity.version;
    stage = "migrate a new empty test-owned database";
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await configureTemporaryDatabaseLogging(control, name);
    await runPrisma(["migrate", "deploy"], url.href);
    pool = new pg.Pool({ connectionString: url.href, max: 3, connectionTimeoutMillis: 5000 });
    if (!customOnly) {
      stage = "original Better Auth database storage cold-key race";
      report.cases.push(await runCase(pool, url.href, "native", undefined, 1000, 3));
      report.cases.push(await runCase(pool, url.href, "native", undefined, 2));
    }
    if (!nativeOnly) {
      stage = "project custom storage race and quota regression";
      const { createFrameworkRateLimitStorage } = await import("../../src/server/auth/framework-rate-limit.ts");
      assert.equal(typeof createFrameworkRateLimitStorage, "function");
      report.cases.push(await runCase(pool, url.href, "custom", createFrameworkRateLimitStorage, 1000, 3));
      report.cases.push(await runCase(pool, url.href, "custom", createFrameworkRateLimitStorage, 2));
    }
    const counts = (await pool.query('SELECT (SELECT count(*) FROM "User")::int AS users, (SELECT count(*) FROM "Session")::int AS sessions, (SELECT count(*) FROM "Account")::int AS accounts')).rows[0];
    assert.deepEqual(counts, { users: 0, sessions: 0, accounts: 0 });
    report.accountData = counts;
  } finally {
    await pool?.end();
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
    report.cleanup = true;
  }
  if (process.env.AUTH_RATE_EVIDENCE_FILE) {
    assert.ok(isAbsolute(process.env.AUTH_RATE_EVIDENCE_FILE), "Evidence path must be explicit and absolute");
    // The record deliberately contains only counters/version numbers. The old
    // failures are retained even after custom storage passes, without DB values.
    await writeFile(process.env.AUTH_RATE_EVIDENCE_FILE, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  console.log(JSON.stringify(report));
}

try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error.code ?? "") ? error.code : "ERROR";
  const detail = code === "ERR_ASSERTION" ? String(error.message).split("\n")[0] : "raw details withheld";
  console.error(`Rate-limit regression failed at ${stage} (${code}; ${detail})`);
  process.exitCode = 1;
}
