import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeArguments } from "../scripts/db/compose.mjs";
import { initializeDatabaseEnvironment } from "../scripts/db/init-env.mjs";

test("local credential initialization creates separate random secrets and never overwrites them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-db-env-test-"));
  const destination = join(directory, ".env.db.local");
  try {
    await initializeDatabaseEnvironment(destination);
    const first = await readFile(destination, "utf8");
    const development = first.match(/^MQ_DEV_PASSWORD=([a-f0-9]{64})$/m)?.[1];
    const testing = first.match(/^MQ_TEST_PASSWORD=([a-f0-9]{64})$/m)?.[1];
    // Boolean assertions ensure failed test reports cannot print generated secrets.
    assert.ok(Boolean(development && testing && development !== testing));
    assert.ok(first.includes(`mq_dev:${development}@127.0.0.1:55432/mq_development`));
    assert.ok(first.includes(`mq_test:${testing}@127.0.0.1:55433/mq_test`));
    await assert.rejects(initializeDatabaseEnvironment(destination), { code: "EEXIST" });
    assert.ok((await readFile(destination, "utf8")) === first);
  } finally {
    await rm(destination, { force: true });
    await rmdir(directory);
  }
});

test("database lifecycle wrapper refuses destructive/raw flags and out-of-scope services", () => {
  for (const parameters of [
    ["down", "-v"], ["down", "all", "--volumes"], ["rm"], ["config"], ["logs"],
    ["up", "unrelated"], ["down", "dev"], ["up", "all", "--file", "other.yaml"],
  ]) {
    assert.throws(() => composeArguments(parameters));
  }
  const down = composeArguments(["down"]);
  assert.ok(down.includes("mq-story-blog"));
  assert.equal(down.at(-1), "down");
  assert.ok(!down.includes("-v") && !down.includes("--volumes"));
  const recreate = composeArguments(["recreate", "test"]);
  assert.equal(recreate.at(-1), "postgres-test");
  assert.ok(!recreate.includes("postgres-dev"));
});
