import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { PasswordWorkQueue } from "../src/server/auth/hash-work-queue.ts";
import { AuthHashBusyError, hashPassword, verifyPassword } from "../src/server/auth/password.ts";

const synthetic = "Synthetic-only-MQ-Password-9087!";

test("password hashes use random salts, the approved cost and real constant-length keys", async () => {
  const first = await hashPassword(synthetic);
  const second = await hashPassword(synthetic);
  assert.match(first, /^\$mq-scrypt\$v=1\$N=32768,r=8,p=3\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword({ hash: first, password: synthetic }), true);
  assert.equal(await verifyPassword({ hash: first, password: `${synthetic}wrong` }), false);
  assert.equal(await verifyPassword({ hash: first, password: ` ${synthetic}` }), false);
});

test("password Unicode normalization matches Better Auth without trimming or NULL truncation", async () => {
  const composed = "仅合成测试-星空🪶-é-9087";
  const hash = await hashPassword(composed);
  assert.equal(await verifyPassword({ hash, password: composed.normalize("NFD") }), true);
  const compatibility = "Ｓｙｎｔｈｅｔｉｃ-１２３-仅测试";
  const compatibleHash = await hashPassword(compatibility);
  assert.equal(await verifyPassword({ hash: compatibleHash, password: compatibility.normalize("NFKC") }), true);
  const embedded = "Synthetic\0with-tail-9087!";
  const embeddedHash = await hashPassword(embedded);
  assert.equal(await verifyPassword({ hash: embeddedHash, password: embedded }), true);
  assert.equal(await verifyPassword({ hash: embeddedHash, password: "Synthetic" }), false);
});

test("malformed hashes, unknown versions and stored resource cost escalation are rejected", async () => {
  const hash = await hashPassword(synthetic);
  for (const corrupt of [
    "", null, 42, "a".repeat(100_000),
    hash.replace("v=1", "v=2"), hash.replace("N=32768", "N=65536"),
    hash.replace("r=8", "r=9"), hash.replace("p=3", "p=9"),
    hash.toUpperCase(), `${hash}\n`, hash.slice(0, -1),
    `${hash.slice(0, -1)}z`, "0".repeat(32) + ":" + "0".repeat(128),
  ]) {
    assert.equal(await verifyPassword({ hash: corrupt, password: synthetic }), false);
  }
});

test("password input bounds are checked before native hashing", async () => {
  const hash = await hashPassword(synthetic);
  for (const invalid of ["", null, 42, "x".repeat(129), "bad\ud800surrogate"]) {
    await assert.rejects(() => hashPassword(invalid), { name: "TypeError", message: "Invalid password input." });
    assert.equal(await verifyPassword({ hash, password: invalid }), false);
  }
  const bounded = "字".repeat(128);
  assert.equal(await verifyPassword({ hash: await hashPassword(bounded), password: bounded }), true);
});

test("real native hash work is bounded to six accepted jobs and recovers after overflow", async () => {
  const outcomes = await Promise.allSettled(Array.from({ length: 9 }, () => hashPassword(synthetic)));
  const accepted = outcomes.filter((result) => result.status === "fulfilled");
  const refused = outcomes.filter((result) => result.status === "rejected");
  assert.equal(accepted.length, 6);
  assert.equal(refused.length, 3);
  assert.equal(refused.every((result) => result.reason instanceof AuthHashBusyError), true);
  assert.equal(new Set(accepted.map((result) => result.value)).size, 6);
  assert.equal(await verifyPassword({ hash: accepted[0].value, password: synthetic }), true);
});

test("queue runs at most two operations, preserves FIFO permits and releases on thrown work", async () => {
  const queue = new PasswordWorkQueue();
  const releases = [];
  const started = [];
  let active = 0;
  let peak = 0;
  const pending = Array.from({ length: 6 }, (_, index) => queue.run(async () => {
    started.push(index);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return index;
  }));
  await assert.rejects(() => queue.run(async () => "overflow"), AuthHashBusyError);
  assert.deepEqual(started, [0, 1]);
  while (started.length < 6) {
    releases.shift()();
    await setImmediate();
    assert.ok(active <= 2);
  }
  for (const release of releases) release();
  assert.deepEqual(await Promise.all(pending), [0, 1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
  await assert.rejects(() => queue.run(async () => { throw new Error("synthetic failure"); }), /synthetic failure/);
  assert.equal(await queue.run(async () => "recovered"), "recovered");
});
