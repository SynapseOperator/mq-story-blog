import assert from "node:assert/strict";
import test from "node:test";
import { validateDatabaseUrl } from "../scripts/db/environment.mjs";

// Synthetic test passwords, never used to connect to an actual database.
const dev = "postgresql://mq_dev:synthetic@127.0.0.1:55432/mq_development";
const target = "postgresql://mq_test:synthetic@127.0.0.1:55433/mq_test";

test("test target cannot resolve to the development database or identity", () => {
  assert.throws(() => validateDatabaseUrl(dev, "test"), /Refusing/);
  assert.throws(() => validateDatabaseUrl(target.replace("/mq_test", "/mq_development"), "test"), /Refusing/);
  assert.throws(() => validateDatabaseUrl(target.replace("mq_test:", "mq_dev:"), "test"), /Refusing/);
  assert.equal(validateDatabaseUrl(target, "test").pathname, "/mq_test");
  assert.equal(validateDatabaseUrl(dev, "dev").pathname, "/mq_development");
});

test("database foundation refuses remote hosts, missing targets and connection overrides", () => {
  for (const value of [undefined, "invalid", target.replace("127.0.0.1", "example.com"), `${target}?host=other`, `${target}#fragment`, target.replace(":55433", "")]) {
    assert.throws(() => validateDatabaseUrl(value, "test"));
  }
  assert.throws(() => validateDatabaseUrl(target, "production"));
});

test("validation failures never disclose URL credentials", () => {
  const secret = "synthetic-value-to-redact";
  const value = `postgresql://mq_test:${secret}@example.com:5432/mq_test`;
  assert.throws(() => validateDatabaseUrl(value, "test"), (error) => {
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes(value));
    return true;
  });
});
