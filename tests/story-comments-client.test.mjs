import assert from "node:assert/strict";
import test from "node:test";
import { decodeCommentReceipt, decodeStoryComments, readStoryComments, submitStoryComment,
  StoryCommentError } from "../src/lib/stories/comments-client.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const item = { id, body: "<img src=x onerror=alert(1)>\n纯文本", author: "匿名访客", createdAt: "2026-11-05T12:00:00.000Z" };
const page = { items: [item], count: 3, nextCursor: "canonical_cursor" };

test("comment transport decoders retain only public fields and never invent counts or receipts", () => {
  assert.deepEqual(decodeStoryComments({ ...page, private: true, items: [{ ...item, userId: "private", state: "APPROVED" }] }), page);
  assert.deepEqual(decodeCommentReceipt({ receiptId: id, state: "PENDING" }), { receiptId: id });
  for (const invalid of [null, {}, { ...page, count: -1 }, { ...page, count: 0.5 }, { ...page, count: "3" },
    { ...page, nextCursor: "?private" }, { ...page, items: [item, item] }, { ...page, items: [{ ...item, createdAt: "invalid" }] }]) {
    assert.throws(() => decodeStoryComments(invalid), StoryCommentError);
  }
  for (const invalid of [null, {}, { receiptId: "" }, { receiptId: "not-a-uuid" }]) assert.throws(() => decodeCommentReceipt(invalid), StoryCommentError);
});

test("GET and POST use no-store and the current same-origin session, with exact frozen DTO and key", async context => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(options.method === "GET" ? page : { receiptId: id }), { status: options.method === "GET" ? 200 : 202 });
  });
  const signal = new globalThis.AbortController().signal;
  assert.deepEqual(await readStoryComments("story/id", "cursor_value", signal), page);
  const frozen = { body: "原正文", identity: "anonymous", accountUserId: "never-send", storyId: "story/id" };
  assert.deepEqual(await submitStoryComment("story/id", frozen, id, signal), { receiptId: id });
  assert.equal(calls[0].url, "/api/stories/story%2Fid/comments?cursor=cursor_value");
  assert.equal(calls[1].url, "/api/stories/story%2Fid/comments");
  assert.equal(calls[1].options.body, JSON.stringify({ body: "原正文", identity: "anonymous" }));
  assert.deepEqual(calls[1].options.headers, { "Content-Type": "application/json", "Idempotency-Key": id });
  for (const { options } of calls) {
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("write failures never retry and distinguish HTTP rejection from unknown or malformed acceptance", async context => {
  let count = 0;
  const fetch = context.mock.method(globalThis, "fetch", async () => {
    count++;
    return new Response("{}", { status: 429, headers: { "retry-after": "17" } });
  });
  const submit = () => submitStoryComment("story", { body: "正文", identity: "account" }, id, new globalThis.AbortController().signal);
  await assert.rejects(submit(), error => error instanceof StoryCommentError && error.status === 429 && error.retryAfter === 17);
  fetch.mock.mockImplementation(async () => { count++; throw new Error("lost response"); });
  await assert.rejects(submit(), /lost response/);
  fetch.mock.mockImplementation(async () => { count++; return new Response("{}", { status: 202 }); });
  await assert.rejects(submit(), error => error instanceof StoryCommentError && error.status === null);
  fetch.mock.mockImplementation(async () => { count++; return new Response(JSON.stringify({ receiptId: id }), { status: 200 }); });
  await assert.rejects(submit(), error => error instanceof StoryCommentError && error.status === null);
  assert.equal(count, 4);
});
