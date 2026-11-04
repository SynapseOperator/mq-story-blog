import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { URL } from "node:url";
import pg from "pg";
import { initializePublishingKey } from "./privileges.mjs";

// This checkpoint only initializes synthetic isolated databases. It never
// reads the existing auth/.env files, generates a key or changes production.
async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 2);
  assert.equal(args[0], "--database");
  const expectedDatabase = args[1];
  assert.match(expectedDatabase, /^mq_test_admin_[a-f0-9]{32}$/);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("TTY_REQUIRED");
  const target = new URL(process.env.MQ_PUBLISH_PROVISION_DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.equal(target.pathname, `/${expectedDatabase}`);
  assert.ok(target.port && !target.search && !target.hash);
  const key = process.env.MQ_PUBLISH_SIGNING_KEY;
  assert.match(key ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(key, process.env.AUTH_SECRET);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const confirmation = await terminal.question(`Initialize an independent publication key for ${expectedDatabase} only.\nType INIT PUBLISH ${expectedDatabase}: `);
    assert.equal(confirmation, `INIT PUBLISH ${expectedDatabase}`);
  } finally { terminal.close(); }
  const pool = new pg.Pool({ connectionString: target.href, max: 1, connectionTimeoutMillis: 5000 });
  try { await initializePublishingKey(pool, { expectedDatabase, key }); }
  finally { await pool.end(); }
  console.log("PUBLISHING_KEY_INITIALIZED; isolated target only");
}

try { await main(); }
catch {
  console.error("PUBLISHING_KEY_INITIALIZATION_REJECTED; connection and key details withheld");
  process.exitCode = 1;
}
