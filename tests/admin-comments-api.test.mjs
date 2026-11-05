import assert from "node:assert/strict";
import test from "node:test";
import { createCommentAdminApi, CommentAdminClientError } from "../src/lib/admin-comments/api.ts";

const { Response, AbortController } = globalThis;
const item = { id: "11111111-1111-4111-8111-111111111111", storyId: "22222222-2222-4222-8222-222222222222",
  storyDraftTitle: "合成工作区标题", storyState: "PUBLISHED", body: "<script>纯文本</script>", author: "匿名访客",
  createdAt: "2026-11-05T12:00:00.000Z", state: "PENDING", version: 0, moderatedAt: null, approvedAt: null };
const decision = { id: item.id, state: "APPROVED", version: 1, moderatedAt: item.createdAt, approvedAt: item.createdAt };
const response = value => Response.json(value);
const rejects = kind => error => error instanceof CommentAdminClientError && error.kind === kind;

test("admin exact rereads preserve plain text, private story labels and the requested identity", async () => {
  const calls = [];
  const api = createCommentAdminApi(async (path, options) => {
    calls.push({ path, options }); return response({ comment: item });
  });
  assert.deepEqual(await api.get(item.id), item);
  assert.equal(calls[0].path, `/api/admin/comments?commentId=${item.id}`);
  assert.equal(calls[0].options.cache, "no-store"); assert.equal(calls[0].options.credentials, "same-origin");
  await assert.rejects(createCommentAdminApi(async () => response({ comment: { ...item, id: item.storyId } })).get(item.id), rejects("unavailable"));
  await assert.rejects(createCommentAdminApi(async () => response({ comment: { ...item, userId: "internal" } })).get(item.id), rejects("unavailable"));
});

test("admin list responses cannot replace the selected state or story with stale data", async () => {
  const api = createCommentAdminApi(async () => response({ items: [item], count: 1, nextCursor: null }));
  assert.equal((await api.list({ state: "PENDING", storyId: item.storyId })).items[0].body, item.body);
  await assert.rejects(api.list({ state: "APPROVED", storyId: item.storyId }), rejects("unavailable"));
  await assert.rejects(api.list({ state: "PENDING", storyId: item.id }), rejects("unavailable"));
});

test("moderation sends the captured version once and treats mismatched success as unknown", async () => {
  const calls = [];
  const api = createCommentAdminApi(async (path, options) => {
    calls.push({ path, options }); return response({ comment: decision });
  });
  assert.deepEqual(await api.moderate(item, "approve"), decision);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: "approve", expectedVersion: 0 });
  for (const result of [{ ...decision, id: item.storyId }, { ...decision, version: 3 }, { ...decision, state: "REJECTED" },
    { ...decision, session: "internal" }]) {
    await assert.rejects(createCommentAdminApi(async () => response({ comment: result })).moderate(item, "approve"), rejects("uncertain"));
  }
});

test("conflicts, denied access and unknown writes stay distinct and never retry or expose response errors", async () => {
  for (const [status, kind] of [[401, "denied"], [403, "denied"], [409, "conflict"], [503, "uncertain"]]) {
    let calls = 0;
    const api = createCommentAdminApi(async () => { calls++; return Response.json({ secret: "SQL_INTERNAL" }, { status }); });
    await assert.rejects(api.moderate(item, "approve"), error => rejects(kind)(error) && !error.message.includes("SQL_INTERNAL"));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const failed = createCommentAdminApi(async () => { calls++; throw new Error("NETWORK_INTERNAL"); });
  await assert.rejects(failed.moderate(item, "approve"), rejects("uncertain")); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(failed.get(item.id, controller.signal), rejects("cancelled"));
});
