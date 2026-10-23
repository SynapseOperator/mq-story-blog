import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { createDatabaseClient } from "../../src/lib/db/client.ts";
import { databaseUrl } from "./environment.mjs";
import { runPrisma } from "./prisma-command.mjs";
import { runCompose } from "./compose.mjs";

let stage = "validate local Compose targets";
async function main() {
  // Ignore CI's disposable service URL; this test exercises the actual Compose file.
  const devUrl = await databaseUrl("dev", { localOnly: true });
  const testUrl = await databaseUrl("test", { localOnly: true });
  assert.equal(new URL(devUrl).port, "55432");
  assert.equal(new URL(testUrl).port, "55433");
  assert.notEqual(new URL(devUrl).password, new URL(testUrl).password);
  const targets = [
    { url: devUrl, value: "synthetic-dev-persistence", database: "mq_development" },
    { url: testUrl, value: "synthetic-test-persistence", database: "mq_test" },
  ];
  const id = randomUUID();
  const seeded = [];
  let failure;
  let checks = 0;
  async function withClient(target, callback) {
    const client = createDatabaseClient(target.url);
    try { return await callback(client); } finally { await client.$disconnect(); }
  }
  async function verifyRows() {
    for (const target of targets) {
      await withClient(target, async (client) => {
        const info = await client.$queryRaw`SELECT current_database() AS db, current_setting('data_directory') AS dir`;
        assert.equal(info[0].db, target.database);
        assert.equal(info[0].dir, "/var/lib/postgresql/18/docker");
        assert.equal((await client.databaseProbe.findUnique({ where: { id } })).value, target.value);
      });
    }
    checks += 1;
    console.log(`PASS ${stage}`);
  }
  try {
    stage = "apply migrations and seed isolated synthetic markers";
    for (const target of targets) {
      await runPrisma(["migrate", "deploy"], target.url);
      await withClient(target, async (client) => {
        await client.databaseProbe.create({ data: { id, value: target.value } });
        seeded.push(target);
      });
    }
    await verifyRows();
    stage = "development credentials cannot authenticate to the test instance";
    const wrong = new URL(testUrl);
    wrong.username = new URL(devUrl).username;
    wrong.password = new URL(devUrl).password;
    // Must fail for authentication, not merely because the instance is unavailable.
    const { default: pg } = await import("pg");
    const wrongClient = new pg.Client({ connectionString: wrong.href, connectionTimeoutMillis: 5000 });
    try { await assert.rejects(wrongClient.connect(), (error) => ["28P01", "28000"].includes(error.code)); }
    finally { await wrongClient.end(); }
    checks += 1;
    console.log(`PASS ${stage}`);

    stage = "stop and start both instances without losing markers";
    assert.equal(await runCompose(["stop"]), 0);
    assert.equal(await runCompose(["start"]), 0);
    await verifyRows();

    stage = "recreate both containers and retain named-volume data";
    assert.equal(await runCompose(["recreate"]), 0);
    await verifyRows();

    stage = "repeat migration deployment after recreation preserves data";
    for (const target of targets) await runPrisma(["migrate", "deploy"], target.url);
    await verifyRows();
  } catch (error) {
    failure = error;
  } finally {
    // Only remove our unique probe, never truncate or clear either database.
    for (const target of seeded) {
      try { await withClient(target, (client) => client.databaseProbe.deleteMany({ where: { id } })); }
      catch (error) {
        failure ??= error;
        console.error("Could not remove this run's probe; the database may be unavailable. No other data was cleared.");
      }
    }
  }
  if (failure) throw failure;
  console.log(`Compose persistence/isolation: ${checks} checks passed`);
}

try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error.code ?? "") ? error.code : "ERROR";
  console.error(`Persistence check FAILED at: ${stage} (${code}). Connection details omitted.`);
  process.exitCode = 1;
}
