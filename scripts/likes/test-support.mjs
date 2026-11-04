import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createStoryService } from "../../src/server/stories/service.ts";
import { transport as draftTransport } from "../admin-drafts/test-support.mjs";

export { assertTemporaryTarget, privateHeaders, observeWait } from "../admin-drafts/test-support.mjs";

export const LIKE_MIGRATION = "202611040007_story_likes";
export const likePath = id => `/api/stories/${id}/likes`;

export function transport(origin, secrets, ca) {
  const request = draftTransport(origin, secrets, ca);
  return (path, options = {}) => {
    const input = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    // Node's DELETE requests do not infer chunked framing. Explicit length is
    // required to actually send the strict JSON body, just as browsers do.
    return request(path, input === undefined ? options : { ...options,
      headers: { "content-length": String(Buffer.byteLength(input)), ...options.headers } });
  };
}

export function assertLikes(response, expected) {
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.data).sort(), ["count", "liked"]);
  assert.ok(Number.isSafeInteger(response.data.count) && response.data.count >= 0);
  assert.equal(typeof response.data.liked, "boolean");
  if (expected) assert.deepEqual(response.data, expected);
  assert.match(response.headers["cache-control"] ?? "", /no-store/);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
}

/** Owner-created synthetic content, only in the caller's disposable database. */
export async function createLikeFixtures(client) {
  const service = createStoryService(client), suffix = randomUUID().replaceAll("-", "");
  const privateCanaries = [`PRIVATE_LIKES_DRAFT_${suffix}`, `PRIVATE_LIKES_WITHDRAWN_${suffix}`, `PRIVATE_LIKES_EDIT_${suffix}`];
  const make = (label, title, slotId = null, long = false) => service.createDraft({
    slug: `likes-${label}-${suffix}`, kind: "STAR", slotId, title,
    content: { version: 1, blocks: Array.from({ length: long ? 24 : 1 }, (_, index) => ({ type: "paragraph",
      text: long ? `第 ${index + 1} 段合成验收文字。晚风经过山坡，星光映在信纸上。这个故事仅用于隔离环境中的点赞、账号窗口与滚动测试，不包含真实姓名、回忆或私人照片。我们继续向下读信，文字和留言始终在同一个信纸内部滚动。` : title })) },
  });
  const publish = story => service.publish({ storyId: story.id, expectedVersion: story.version });
  const first = await publish(await make("long", "合成验收 · 点赞与星光长信", "star-1", true));
  await service.saveDraft({ storyId: first.id, expectedVersion: first.version, title: privateCanaries[2],
    content: { version: 1, blocks: [{ type: "paragraph", text: privateCanaries[2] }] } });
  const second = await publish(await make("short", "合成验收 · 另一封公开书信", "star-2"));
  const draft = await make("draft", privateCanaries[0]);
  let withdrawn = await publish(await make("withdrawn", privateCanaries[1], "star-3"));
  withdrawn = await service.withdraw({ storyId: withdrawn.id, expectedVersion: withdrawn.version });
  return { first: { ...first, title: "合成验收 · 点赞与星光长信" }, second, draft, withdrawn, privateCanaries };
}
