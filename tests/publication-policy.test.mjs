import assert from "node:assert/strict";
import { test } from "node:test";
import { publicationInput, publicationKey } from "../src/server/admin/publishing/policy.ts";

test("publishing accepts only version and the explicit slot contract", () => {
  assert.deepEqual(publicationInput({ expectedVersion: 0 }, "publish"), { expectedVersion: 0, slotId: null });
  assert.deepEqual(publicationInput({ expectedVersion: 1, slotId: null }, "slot"), { expectedVersion: 1, slotId: null });
  for (const input of [null, {}, { expectedVersion: -1 }, { expectedVersion: 1.1 },
    { expectedVersion: 2147483647 }, { expectedVersion: 0, state: "PUBLISHED" },
    { expectedVersion: 0, revisionId: "private" }, { expectedVersion: 0, role: "admin" }]) {
    assert.throws(() => publicationInput(input, "publish"), { publicationCode: "PUBLISH_VALIDATION" });
  }
  for (const slotId of ["../../secret", "", {}, 1]) {
    assert.throws(() => publicationInput({ expectedVersion: 0, slotId }, "slot"));
  }
  assert.throws(() => publicationInput({ expectedVersion: 0 }, "slot"));
});

test("publishing fails closed without a dedicated key and never reuses authentication key", () => {
  const keys = ["MQ_PUBLISH_ENABLED", "MQ_PUBLISH_SIGNING_KEY", "AUTH_SECRET", "BETTER_AUTH_SECRET", "MQ_AUTH_SECRET"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.throws(publicationKey, { publicationCode: "PUBLISH_UNAVAILABLE" });
    process.env.MQ_PUBLISH_ENABLED = "true";
    assert.throws(publicationKey);
    process.env.MQ_PUBLISH_SIGNING_KEY = "synthetic-invalid";
    assert.throws(publicationKey);
    process.env.MQ_PUBLISH_SIGNING_KEY = "ab".repeat(32);
    assert.equal(publicationKey().length, 32);
    process.env.AUTH_SECRET = process.env.MQ_PUBLISH_SIGNING_KEY;
    assert.throws(publicationKey);
    delete process.env.AUTH_SECRET;
    process.env.MQ_PUBLISH_ENABLED = "false";
    assert.throws(publicationKey);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
