import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { URL } from "node:url";
import { configureTemporaryDatabaseLogging, logPrivacySettings } from "../scripts/db/log-privacy.mjs";

test("both Compose services retain the reviewed PostgreSQL error audit/privacy settings", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  const services = compose.split(/ {2}postgres-(?:dev|test):/).slice(1);
  assert.equal(services.length, 2);
  for (const [key, value] of await logPrivacySettings()) {
    for (const service of services) assert.ok(service.includes(`"${key}=${value}"`), `Missing ${key}`);
  }
});

test("temporary logging configuration refuses existing application databases before querying", async () => {
  for (const name of ["mq_test", "mq_development", "postgres", 'mq_test_auth_"; DROP DATABASE postgres; --']) {
    await assert.rejects(configureTemporaryDatabaseLogging(null, name));
  }
});
