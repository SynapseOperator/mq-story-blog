import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { createDatabaseClient } from "../../src/lib/db/client.ts";
import { databaseUrl } from "../db/environment.mjs";
import { configureTemporaryDatabaseLogging, verifyDatabaseLogging } from "../db/log-privacy.mjs";

const report = {
  platform: process.platform, node: process.version, prisma: "7.10.1", poolSize: 3,
  purpose: "Real PostgreSQL pool acquisition budget probe without business tables or accounts",
  interpretation: "This controlled probe demonstrates timeout behavior; it does not identify the cause of a historical CI HTTP failure",
  cases: [], cleanup: false,
};
let stage = "validate isolated database";

async function probe(client, mode) {
  let release;
  let allEntered;
  let enteredCount = 0;
  let arrivalTimeout;
  let releaseTimer;
  const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { allEntered = resolve; });
  // Explicit blocker options keep the three known test transactions alive.
  // Only the fourth transaction uses the client's default/candidate settings.
  const holders = Array.from({ length: 3 }, () => client.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 AS probe`;
    enteredCount += 1;
    if (enteredCount === 3) allEntered();
    await held;
    return (await tx.$queryRaw`SELECT 1 AS probe`)[0].probe;
  }, { maxWait: 5000, timeout: 10000 }));
  const settledHolders = Promise.allSettled(holders);
  let result;
  try {
    await Promise.race([entered, new Promise((_, reject) => {
      arrivalTimeout = setTimeout(() => reject(new Error("Probe connections did not become ready")), 5000);
    })]);
    clearTimeout(arrivalTimeout);
    assert.equal(enteredCount, 3, "Three real transactions must occupy the complete pool");
    const startedAt = performance.now();
    releaseTimer = setTimeout(release, 3000);
    let code = "SUCCESS";
    let value;
    try {
      // Exactly the callback form Better Auth invokes, with no per-call options.
      value = await client.$transaction(async tx => (await tx.$queryRaw`SELECT 1 AS probe`)[0].probe);
    } catch (error) {
      code = error?.code === "P2028" ? "P2028" : "UNEXPECTED_FAILURE";
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (mode === "default") {
      assert.equal(code, "P2028", "The default two-second acquisition budget must expire while three connections remain occupied");
    } else {
      assert.equal(code, "SUCCESS", "The candidate five-second budget must allow acquisition after the three-second release");
      assert.equal(value, 1, "The queued transaction must execute against real PostgreSQL");
      assert.ok(elapsedMs >= 2800, "The successful transaction must actually wait for the occupied pool");
    }
    result = { mode, code, elapsedMs, maxWaitMs: mode === "default" ? 2000 : 5000,
      timeoutMs: 5000, scheduledReleaseAfterMs: 3000, passed: true };
  } finally {
    clearTimeout(arrivalTimeout);
    clearTimeout(releaseTimer);
    release();
    const settled = await settledHolders;
    await client.$disconnect();
    assert.ok(settled.every(item => item.status === "fulfilled" && item.value === 1), "All test-owned pool holders must complete cleanly");
  }
  return result;
}

async function main() {
  const base = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  const name = `mq_test_auth_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^mq_test_auth_[a-f0-9]{32}$/);
  const target = new URL(base);
  target.pathname = `/${name}`;
  let created = false;
  let inspection;
  try {
    const identity = (await control.query("SELECT current_database() AS db, current_user AS usr, current_setting('server_version_num') AS version")).rows[0];
    assert.equal(identity.db, "mq_test");
    assert.equal(identity.usr, "mq_test");
    assert.ok(Number(identity.version) >= 180000 && Number(identity.version) < 190000);
    report.postgresVersion = identity.version;
    stage = "create a test-owned empty database with private logging";
    await control.query(`CREATE DATABASE "${name}"`);
    created = true;
    await configureTemporaryDatabaseLogging(control, name);
    inspection = new pg.Pool({ connectionString: target.href, max: 1, connectionTimeoutMillis: 5000 });
    await verifyDatabaseLogging(inspection);
    stage = "observe default Prisma transaction acquisition timeout";
    report.cases.push(await probe(createDatabaseClient(target.href), "default"));
    stage = "observe explicitly bounded candidate transaction acquisition";
    report.cases.push(await probe(createAuthDatabaseClient(target.href), "authentication"));
    const tables = (await inspection.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'")).rows[0].count;
    assert.equal(tables, 0, "This probe must not create business tables or account records");
    report.businessTables = tables;
  } finally {
    await inspection?.end();
    if (created) await control.query(`DROP DATABASE "${name}"`);
    await control.end();
    report.cleanup = true;
  }
  if (process.env.AUTH_TRANSACTION_EVIDENCE_FILE) {
    assert.ok(isAbsolute(process.env.AUTH_TRANSACTION_EVIDENCE_FILE), "Evidence destination must be explicit and absolute");
    await writeFile(process.env.AUTH_TRANSACTION_EVIDENCE_FILE, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
  console.log(JSON.stringify(report));
}

try { await main(); }
catch (error) {
  const code = error?.code === "ERR_ASSERTION" ? "ASSERTION_FAILURE" : "PROBE_FAILURE";
  console.error(`Transaction queue regression failed at ${stage} (${code}; raw details withheld)`);
  process.exitCode = 1;
}
