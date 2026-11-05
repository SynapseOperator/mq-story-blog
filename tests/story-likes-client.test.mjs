import assert from "node:assert/strict";
import test from "node:test";
import { decodeStoryLikes, requestStoryLikes, StoryLikeError } from "../src/lib/stories/likes-client.ts";

test("likes decoder retains only an actual count and current-user state", () => {
  assert.deepEqual(decodeStoryLikes({ count: 12, liked: true, userId: "private", token: "private" }), { count: 12, liked: true });
  assert.deepEqual(decodeStoryLikes({ count: 0, liked: false }), { count: 0, liked: false });
  for (const value of [null, [], {}, { count: -1, liked: false }, { count: 0.5, liked: true },
    { count: Number.MAX_SAFE_INTEGER + 1, liked: false }, { count: "3", liked: false }, { count: 3, liked: 1 }]) {
    assert.throws(() => decodeStoryLikes(value), StoryLikeError);
  }
});

test("like requests use the current same-origin session and explicit idempotent methods", async context => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ count: 1, liked: true, internal: "discard" }), { status: 200 });
  });
  const signal = new globalThis.AbortController().signal;
  for (const method of ["GET", "PUT", "DELETE"]) {
    assert.deepEqual(await requestStoryLikes("story/id", method, signal), { count: 1, liked: true });
  }
  assert.equal(calls.length, 3);
  for (const { url, options } of calls) {
    assert.equal(url, "/api/stories/story%2Fid/likes");
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body, options.method === "GET" ? undefined : "{}");
    assert.deepEqual(options.headers, options.method === "GET" ? undefined : { "Content-Type": "application/json" });
  }
});

test("failed or lost writes never retry and preserve error categories for reconciliation", async context => {
  let calls = 0;
  const fetch = context.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("{}", { status: 401 });
  });
  await assert.rejects(requestStoryLikes("story", "PUT", new globalThis.AbortController().signal), error => error instanceof StoryLikeError && error.status === 401);
  fetch.mock.mockImplementation(async () => { calls++; throw new Error("response lost"); });
  await assert.rejects(requestStoryLikes("story", "DELETE", new globalThis.AbortController().signal), /response lost/);
  assert.equal(calls, 2);
});
