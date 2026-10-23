import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import pg from "pg";
import { createDatabaseClient } from "../../src/lib/db/client.ts";
import { databaseUrl } from "./environment.mjs";
import { runPrisma } from "./prisma-command.mjs";
import { runStoryIntegration } from "./story-integration.mjs";

let stage = "validate test target";
let passed = 0;
function pass(name) { passed += 1; console.log(`PASS ${name}`); }

async function main() {
  const baseUrl = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: baseUrl, max: 1, connectionTimeoutMillis: 5000 });
  const created = [];
  const clients = [];
  const token = randomUUID().replaceAll("-", "");
  const names = [`mq_test_it_${token}`, `mq_test_isolated_${token}`];
  const urls = names.map((name) => { const url = new URL(baseUrl); url.pathname = `/${name}`; return url.href; });
  let failure;
  try {
    stage = "connect to PostgreSQL 18 test instance";
    const info = (await control.query("SELECT current_database() AS db, current_user AS usr, current_setting('server_version_num') AS version")).rows[0];
    assert.equal(info.db, "mq_test");
    assert.equal(info.usr, "mq_test");
    assert.ok(Number(info.version) >= 180000 && Number(info.version) < 190000);
    console.log(`PostgreSQL server_version_num=${info.version}`);
    pass(stage);

    stage = "create two isolated empty databases";
    for (const name of names) {
      // Identifiers are generated here, never supplied by URLs or user input.
      assert.match(name, /^mq_test_(it|isolated)_[a-f0-9]{32}$/);
      await control.query(`CREATE DATABASE "${name}"`);
      created.push(name);
    }
    for (const url of urls) {
      const client = createDatabaseClient(url);
      clients.push(client);
      const tables = await client.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
      assert.equal(tables.length, 0);
    }
    pass(stage);

    stage = "apply committed migrations to both empty databases";
    for (const url of urls) await runPrisma(["migrate", "deploy"], url);
    for (const client of clients) {
      const history = await client.$queryRaw`SELECT migration_name, finished_at FROM _prisma_migrations WHERE rolled_back_at IS NULL`;
      assert.ok(history.length > 0 && history.every((migration) => migration.finished_at));
      assert.equal(await client.databaseProbe.count(), 0);
    }
    pass(stage);

    stage = "repeat migration deployment without data loss or duplicate history";
    const before = await clients[0].$queryRaw`SELECT migration_name FROM _prisma_migrations ORDER BY migration_name`;
    await runPrisma(["migrate", "deploy"], urls[0]);
    await runPrisma(["migrate", "status"], urls[0]);
    assert.deepEqual(await clients[0].$queryRaw`SELECT migration_name FROM _prisma_migrations ORDER BY migration_name`, before);
    pass(stage);

    stage = "migration schema matches the Prisma schema";
    await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], urls[0]);
    pass(stage);

    stage = "Prisma create, read and update against PostgreSQL";
    const id = randomUUID();
    const record = await clients[0].databaseProbe.create({ data: { id, value: "synthetic-integration-probe" } });
    assert.ok(record.createdAt instanceof Date);
    await clients[0].databaseProbe.update({ where: { id }, data: { value: "synthetic-updated" } });
    assert.equal((await clients[0].databaseProbe.findUnique({ where: { id } })).value, "synthetic-updated");
    pass(stage);

    stage = "database primary key prevents duplicate identities";
    await assert.rejects(clients[0].databaseProbe.create({ data: { id, value: "duplicate" } }), (error) => error.code === "P2002");
    pass(stage);

    stage = "transaction rollback leaves no partial record";
    const rollbackId = randomUUID();
    await assert.rejects(clients[0].$transaction(async (tx) => {
      await tx.databaseProbe.create({ data: { id: rollbackId, value: "must-rollback" } });
      throw new Error("intentional-probe-rollback");
    }), /intentional-probe-rollback/);
    assert.equal(await clients[0].databaseProbe.findUnique({ where: { id: rollbackId } }), null);
    pass(stage);

    stage = "test databases cannot see each other's rows";
    assert.equal(await clients[1].databaseProbe.findUnique({ where: { id } }), null);
    await clients[1].databaseProbe.create({ data: { id, value: "other-isolated-database" } });
    assert.equal((await clients[0].databaseProbe.findUnique({ where: { id } })).value, "synthetic-updated");
    assert.equal((await clients[1].databaseProbe.findUnique({ where: { id } })).value, "other-isolated-database");
    pass(stage);

    stage = "delete a probe through Prisma";
    await clients[0].databaseProbe.delete({ where: { id } });
    assert.equal(await clients[0].databaseProbe.findUnique({ where: { id } }), null);
    pass(stage);
    stage = "story lifecycle and database constraints";
    await runStoryIntegration(clients[0], clients[1], pass);
  } catch (error) {
    failure = error;
  } finally {
    // Attempt every cleanup even if a disconnect/drop fails. Keep the original
    // failure and never force-terminate connections or remove an unrelated DB.
    for (const result of await Promise.allSettled(clients.map((client) => client.$disconnect()))) {
      if (result.status === "rejected") failure ??= result.reason;
    }
    for (const name of created) {
      try { await control.query(`DROP DATABASE "${name}"`); }
      catch (error) { failure ??= error; }
    }
    try { await control.end(); } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  pass("remove only this run's temporary databases");
  console.log(`Database integration: ${passed} checks passed`);
}

try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error.code ?? "") ? error.code : "ERROR";
  console.error(`Database integration FAILED at: ${error.storyStage ?? stage} (${code}). Connection details omitted.`);
  process.exitCode = 1;
}
