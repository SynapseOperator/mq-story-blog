import assert from "node:assert/strict";
import test from "node:test";
import { classifyAuthFailure } from "../src/server/auth/failure.ts";
import { AuthHashBusyError } from "../src/server/auth/hash-work-queue.ts";

test("only identified password queue overflow is classified as hash capacity", () => {
  const busy = classifyAuthFailure(new AuthHashBusyError(), "framework");
  assert.equal(busy.status, 503);
  assert.equal(busy.code, "AUTH_HASH_BUSY");
  assert.ok(busy.retryAfter > 0);
  for (const error of [
    new Error("AUTH_HASH_BUSY"),
    { status: 503, headers: { "retry-after": "5" } },
    { status: 429, message: "rate limit" },
    { code: "P2002", meta: { target: ["key"] } },
    { code: "23505", constraint: "RateLimit_key_key" },
    new Error("unexpected synthetic backend failure"),
  ]) {
    const failure = classifyAuthFailure(error, "framework");
    assert.equal(failure.status, 500);
    assert.equal(failure.code, "AUTH_INTERNAL_ERROR");
    assert.equal(failure.retryAfter, undefined);
  }
});

test("limiter failures fail closed in a category distinct from quota and password work", () => {
  for (const [error, stage] of [
    [new Error("synthetic project limiter trigger"), "project-limit"],
    [{ code: "P2002" }, "project-limit"],
    [{ code: "AUTH_LIMITER_FAILURE" }, "framework"],
  ]) {
    const failure = classifyAuthFailure(error, stage);
    assert.equal(failure.status, 503);
    assert.equal(failure.code, "AUTH_LIMITER_ERROR");
    assert.notEqual(failure.code, "RATE_LIMITED");
    assert.notEqual(failure.code, "AUTH_HASH_BUSY");
  }
});

test("known connectivity failures differ from integrity and unexpected errors", () => {
  for (const code of ["P1001", "P1002", "P1017", "ECONNREFUSED", "ETIMEDOUT"]) {
    const failure = classifyAuthFailure({ code }, "framework");
    assert.equal(failure.status, 503);
    assert.equal(failure.code, "AUTH_STORAGE_UNAVAILABLE");
  }
  const configuration = classifyAuthFailure(new Error("missing configuration"), "config");
  assert.equal(configuration.status, 503);
  assert.equal(configuration.code, "AUTH_UNAVAILABLE");
});

test("failure classification emits fixed audit metadata without database/error fields", () => {
  const sensitive = "synthetic-internal@accounts.invalid token-placeholder password-placeholder";
  for (const stage of ["config", "project-limit", "framework"]) {
    const failure = classifyAuthFailure({ message: sensitive, detail: sensitive,
      cause: { message: sensitive }, stack: sensitive }, stage);
    assert.match(failure.event, /^[A-Z0-9_]+$/);
    assert.equal(JSON.stringify(failure).includes(sensitive), false);
    assert.ok(Object.keys(failure).every(key => ["status", "code", "event", "retryAfter"].includes(key)));
  }
});
