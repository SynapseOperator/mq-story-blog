import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { createStoryService } from "../../src/server/stories/service.ts";

export { assertTemporaryTarget, privateHeaders, observeWait } from "../admin-drafts/test-support.mjs";
export { transport } from "../likes/test-support.mjs";

export const commentPath = id => `/api/stories/${id}/comments`;
export const moderatePath = id => `/api/admin/comments/${id}/moderate`;

export function assertCommentHeaders(response) {
  assert.match(response.headers["cache-control"] ?? "", /no-store/);
  assert.match(response.headers["content-type"] ?? "", /application\/json/);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
}

export function assertReceipt(response) {
  assert.equal(response.status, 202); assertCommentHeaders(response);
  assert.deepEqual(Object.keys(response.data), ["receiptId"]);
  assert.match(response.data.receiptId, /^[a-f0-9-]{36}$/);
  return response.data.receiptId;
}

export function assertCommentPage(response, { admin = false, count } = {}) {
  assert.equal(response.status, 200); assertCommentHeaders(response);
  assert.deepEqual(Object.keys(response.data).sort(), ["count", "items", "nextCursor"]);
  const page = response.data;
  assert.ok(Number.isSafeInteger(page.count) && page.count >= 0);
  if (count !== undefined) assert.equal(page.count, count);
  assert.ok(Array.isArray(page.items));
  assert.ok(page.nextCursor === null || (typeof page.nextCursor === "string" && page.nextCursor.length <= 1024));
  for (const item of page.items) {
    assert.deepEqual(Object.keys(item).sort(), (admin
      ? ["id", "body", "author", "createdAt", "storyId", "state", "version", "moderatedAt", "approvedAt"]
      : ["id", "body", "author", "createdAt"]).sort());
    assert.match(item.id, /^[a-f0-9-]{36}$/);
    assert.equal(typeof item.body, "string"); assert.equal(typeof item.author, "string");
    assert.ok(Number.isFinite(Date.parse(item.createdAt)));
    if (admin) {
      assert.ok(["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"].includes(item.state));
      assert.ok(Number.isSafeInteger(item.version) && item.version >= 0);
      for (const field of ["moderatedAt", "approvedAt"]) assert.ok(item[field] === null || Number.isFinite(Date.parse(item[field])));
    }
  }
  return page;
}

export function assertModerated(response, { id, state, version }) {
  assert.equal(response.status, 200); assertCommentHeaders(response);
  assert.deepEqual(Object.keys(response.data), ["comment"]);
  const item = response.data.comment;
  assert.deepEqual(Object.keys(item).sort(), ["approvedAt", "id", "moderatedAt", "state", "version"]);
  assert.equal(item.id, id); assert.equal(item.state, state); assert.equal(item.version, version);
  assert.ok(Number.isFinite(Date.parse(item.moderatedAt)));
  assert.ok(item.approvedAt === null || Number.isFinite(Date.parse(item.approvedAt)));
  return item;
}

export function assertCommentError(response, status, code) {
  assert.equal(response.status, status); assertCommentHeaders(response);
  assert.deepEqual(response.data, { code });
}

export async function createCommentFixtures(client) {
  const stories = createStoryService(client), suffix = randomUUID();
  const privateCanaries = [`PRIVATE_COMMENT_DRAFT_${suffix}`, `PRIVATE_COMMENT_WITHDRAWN_${suffix}`];
  const make = (label, title, slotId = null) => stories.createDraft({ kind: "STAR", slug: `comments-${label}-${suffix}`, slotId,
    title, content: { version: 1, blocks: [{ type: "paragraph", text: title }] } });
  const publish = story => stories.publish({ storyId: story.id, expectedVersion: story.version });
  const first = await publish(await make("first", "合成留言测试故事", "star-1"));
  const second = await publish(await make("second", "另一篇合成留言故事", "star-2"));
  const draft = await make("draft", privateCanaries[0]);
  let withdrawn = await publish(await make("withdrawn", privateCanaries[1], "star-3"));
  withdrawn = await stories.withdraw({ storyId: withdrawn.id, expectedVersion: withdrawn.version });
  return { first, second, draft, withdrawn, privateCanaries };
}

/** Drop the actual response stream before reading any receipt. The caller must
 * independently inspect the committed row, then retry through the normal HTTP API. */
export async function submitAndDropResponse(origin, path, { ca, key, body, jar }) {
  const bytes = JSON.stringify(body), target = new URL(path, origin);
  assert.equal(target.hostname, "127.0.0.1");
  assert.ok(target.protocol === "http:" || (target.protocol === "https:" && ca));
  await new Promise((resolve, reject) => {
    let dropped = false;
    const request = (target.protocol === "https:" ? https : http).request(target, {
      method: "POST", ca, timeout: 30_000, headers: { origin, "content-type": "application/json",
        "content-length": String(Buffer.byteLength(bytes)), "idempotency-key": key, ...(jar?.cookie ? { cookie: jar.cookie } : {}) },
    }, response => {
      dropped = true; response.destroy(); request.destroy(); resolve();
    });
    request.once("error", error => { if (!dropped) reject(error); });
    request.once("timeout", () => request.destroy(new Error("COMMENT_LOST_RESPONSE_TIMEOUT")));
    request.end(bytes);
  });
}
