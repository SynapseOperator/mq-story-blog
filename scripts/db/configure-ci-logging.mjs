import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { logPrivacySettings, verifyDatabaseLogging } from "./log-privacy.mjs";

// This command changes only the disposable GitHub Actions service. It must not
// be used to change local/production PostgreSQL server-wide defaults.
let pool;
try {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.CI, "true");
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/);
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.equal(connectionString, "postgresql://mq_test@127.0.0.1:5432/mq_test",
    "CI service configuration requires its explicit loopback-only target; no local env fallback");
  pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const identity = (await pool.query("SELECT current_database() AS db, current_user AS usr")).rows[0];
  assert.equal(identity.db, "mq_test");
  assert.equal(identity.usr, "mq_test");
  for (const [key, value] of await logPrivacySettings()) await pool.query(`ALTER SYSTEM SET ${key} TO '${value}'`);
  await pool.query("SELECT pg_reload_conf()");
  await pool.end();
  pool = undefined;
  let verified = false;
  for (let attempt = 0; attempt < 10 && !verified; attempt += 1) {
    await delay(250);
    pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
    try { await verifyDatabaseLogging(pool, { server: true }); verified = true; }
    catch { if (attempt === 9) throw new Error("Reload verification timed out"); }
    finally { await pool.end(); pool = undefined; }
  }
  console.log("PASS disposable CI PostgreSQL stderr privacy policy; ERROR/SQLSTATE audit retained");
} catch {
  console.error("CI database logging configuration failed (driver details withheld)");
  process.exitCode = 1;
} finally { await pool?.end(); }
