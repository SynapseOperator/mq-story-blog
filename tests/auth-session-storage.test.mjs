import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createSessionCodec, SessionStorageError } from "../src/server/auth/session-storage.ts";
import { protectedPrismaAdapter } from "../src/server/auth/session-adapter.ts";

const key = randomBytes(32).toString("hex");
const codec = createSessionCodec(key);
const raw = () => ({ id: "synthetic-session", userId: "synthetic-user", token: "A".repeat(32),
  createdAt: new Date("2026-11-08T00:00:00.000Z"), expiresAt: new Date("2026-11-09T00:00:00.000Z"),
  updatedAt: new Date("2026-11-08T00:00:00.000Z"), ipAddress: "", userAgent: "Synthetic test" });

test("session storage has randomized authenticated encryption and a stable non-bearer lookup index", () => {
  const row = raw(); const a = codec.seal(row); const b = codec.seal(row);
  assert.match(a.token, /^hmac1:[a-f0-9]{64}$/);
  assert.match(a.tokenCiphertext, /^v1:[a-f0-9]{24}:[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.equal(a.token, b.token); assert.notEqual(a.tokenCiphertext, b.tokenCiphertext);
  assert.equal(JSON.stringify(a).includes(row.token), false);
  assert.deepEqual(codec.open(a), row);
  assert.equal(row.token, "A".repeat(32), "sealing does not mutate framework data");
  assert.notEqual(codec.index(a.token), a.token, "a stored index is always indexed again, never trusted");
});

test("identity, lifetime, ciphertext and index tampering are rejected without diagnostic values", () => {
  const stored = codec.seal(raw());
  for (const changed of [
    { id: "other-session" }, { userId: "other-user" }, { token: `hmac1:${"0".repeat(64)}` },
    { createdAt: new Date("2026-11-08T01:00:00Z") }, { expiresAt: new Date("2036-11-08T01:00:00Z") },
    { tokenCiphertext: stored.tokenCiphertext.slice(0, -1) + (stored.tokenCiphertext.endsWith("0") ? "1" : "0") },
    { tokenCiphertext: stored.tokenCiphertext.replace("v1:", "v2:") }, { tokenCiphertext: "unprotected" },
    { expiresAt: new Date("invalid") }, { createdAt: "2026-11-08T00:00:00.000Z" },
  ]) assert.throws(() => codec.open({ ...stored, ...changed }), { name: "SessionStorageError", message: "SESSION_STORAGE_REJECTED" });
  assert.throws(() => createSessionCodec(randomBytes(32).toString("hex")).open(stored), SessionStorageError);
});

test("envelopes cannot be exchanged between valid sessions or decoded with an auth-secret fallback", () => {
  const a = codec.seal(raw()); const b = codec.seal({ ...raw(), id: "second", token: "B".repeat(32) });
  assert.throws(() => codec.open({ ...a, tokenCiphertext: b.tokenCiphertext }), SessionStorageError);
  for (const invalid of [undefined, "", "a".repeat(63), "A".repeat(64), ` ${key}`, `${key}\n`]) {
    assert.throws(() => createSessionCodec(invalid), SessionStorageError);
  }
  assert.throws(() => codec.open(raw()), SessionStorageError);
  assert.throws(() => codec.seal({ ...raw(), token: a.token }), SessionStorageError);
});

test("official adapter projection verifies the whole envelope before returning the requested token", async () => {
  let requested;
  const stored = codec.seal(raw());
  const adapter = protectedPrismaAdapter({ session: { async findFirst(input) { requested = input; return stored; } } }, key)({});
  const result = await adapter.findOne({ model: "session", where: [{ field: "token", value: raw().token }], select: ["token"] });
  assert.deepEqual(Object.keys(result), ["token"]);
  assert.equal(result.token === raw().token, true);
  assert.equal(requested.where.token.equals === stored.token, true);
  for (const field of ["id", "userId", "token", "tokenCiphertext", "createdAt", "expiresAt"]) assert.equal(requested.select[field], true);
  stored.userId = "different-user";
  await assert.rejects(adapter.findOne({ model: "session", where: [{ field: "id", value: stored.id }], select: ["id"] }), SessionStorageError);
});

test("official native user/session joins decrypt every related session and strip storage-only fields", async () => {
  const stored = codec.seal(raw());
  const adapter = protectedPrismaAdapter({ user: { async findFirst() { return {
    id: stored.userId, name: "Synthetic", email: "synthetic@accounts.invalid", emailVerified: false,
    createdAt: stored.createdAt, updatedAt: stored.createdAt, sessions: [stored],
  }; } } }, key)({ advanced: { database: { joins: true } } });
  const user = await adapter.findOne({ model: "user", where: [{ field: "id", value: stored.userId }], join: { session: true } });
  assert.equal(user.session.length, 1);
  assert.equal(user.session[0].token === raw().token, true);
  assert.equal("tokenCiphertext" in user.session[0], false);
});

test("unsupported stores, caches and token comparisons fail explicitly instead of bypassing encryption", async () => {
  const create = protectedPrismaAdapter({}, key);
  for (const options of [{ secondaryStorage: {} }, { session: { cookieCache: { enabled: true } } },
    { session: { fields: { token: "other" } } }, { session: { additionalFields: { role: { type: "string" } } } },
    { advanced: { database: { generateId: "serial" } } }, { advanced: { database: { generateId: false } } }]) {
    assert.throws(() => create(options), SessionStorageError);
  }
  const adapter = create({});
  await assert.rejects(adapter.findOne({ model: "session", where: [{ field: "token", operator: "starts_with", value: "A" }] }), SessionStorageError);
  await assert.rejects(adapter.findMany({ model: "session", sortBy: { field: "token", direction: "asc" } }), SessionStorageError);
});
