import assert from "node:assert/strict";
import test from "node:test";
import { URLSearchParams } from "node:url";
import { draftCreate, draftSave, draftPage, draftId, encodeDraftCursor, readDraftBody,
  DRAFT_BODY_LIMIT, DraftOperationError } from "../src/server/admin/drafts/policy.ts";
import { AdminAccessError } from "../src/server/admin/policy.ts";
const { structuredClone, ReadableStream, TextEncoder } = globalThis;
const content = { version: 1, blocks: [{ type: "paragraph", text: "合成草稿，不是真实回忆。" }] };
const rejects = code => error => error instanceof DraftOperationError && error.draftCode === code;

test("draft error is a trusted admin exception without private driver or content fields", () => {
  const e = new DraftOperationError("DRAFT_CONFLICT");
  assert.ok(e instanceof AdminAccessError);
  assert.equal(e.status, 409);
  assert.equal(e.code, "ADMIN_REQUEST_REJECTED");
  assert.equal(e.draftCode, "DRAFT_CONFLICT");
  assert.equal(e.cause, undefined);
});
test("strict draft DTOs reject publication, identity and permission injection without mutating input", () => {
  const input = { kind: "STAR", title: " 合成标题 ", content: structuredClone(content) };
  const before = structuredClone(input);
  assert.equal(draftCreate(input).title, "合成标题");
  for (const key of ["id", "slug", "state", "slotId", "publishedRevisionId", "draftRevisionId", "role", "admin"]) {
    assert.throws(() => draftCreate({ ...input, [key]: "injected" }), rejects("DRAFT_VALIDATION"));
  }
  assert.deepEqual(input, before);
  const saved = { expectedVersion: 4, title: input.title, content: input.content };
  assert.equal(draftSave(saved).expectedVersion, 4);
  for (const value of [-1, 1.5, "4", 2_147_483_647]) {
    assert.throws(() => draftSave({ ...saved, expectedVersion: value }), rejects("DRAFT_VALIDATION"));
  }
  assert.throws(() => draftSave({ ...saved, slug: "new" }), rejects("DRAFT_VALIDATION"));
  assert.equal(saved.title, input.title);
});
test("draft content uses existing validation and bounded local media references only", () => {
  const input = { kind: "CAMPFIRE", title: "合成", content };
  const image = src => ({ version: 1, blocks: [{ type: "image", src, alt: "合成配图" }] });
  assert.equal(draftCreate({ ...input, content: image("/scene/night-sky.webp") }).content.blocks[0].type, "image");
  for (const src of ["https://example.invalid/private.webp", "/story-media/unknown.webp", "/scene/couple.webp", "/story-media/../secret", "data:image/png,x"]) {
    assert.throws(() => draftCreate({ ...input, content: image(src) }), rejects("DRAFT_VALIDATION"));
  }
  for (const value of [{ version: 1, blocks: [] }, { version: 1, blocks: [{ type: "html", text: "<script>" }] }]) {
    assert.throws(() => draftCreate({ ...input, content: value }), rejects("DRAFT_VALIDATION"));
  }
});
test("bounded keyset paging rejects ambiguous, malformed and extra query values", () => {
  assert.deepEqual(draftPage(new URLSearchParams()), { limit: 20 });
  const cursor = { createdAt: "2026-01-01T00:00:00.000Z", id: "11111111-1111-4111-8111-111111111111" };
  assert.deepEqual(draftPage(new URLSearchParams({ limit: "50", cursor: encodeDraftCursor(cursor) })), { limit: 50, cursor });
  for (const query of ["limit=0", "limit=51", "limit=1&limit=2", "state=PUBLISHED", "cursor=%%%", "cursor=", "limit=01"]) {
    assert.throws(() => draftPage(new URLSearchParams(query)), rejects("DRAFT_VALIDATION"));
  }
  const invalid = Buffer.from(JSON.stringify({ ...cursor, extra: true })).toString("base64url");
  assert.throws(() => draftPage(new URLSearchParams({ cursor: invalid })), rejects("DRAFT_VALIDATION"));
  const outOfRange = Buffer.from(JSON.stringify({ ...cursor, createdAt: "-100000-01-01T00:00:00.000Z" })).toString("base64url");
  assert.throws(() => draftPage(new URLSearchParams({ cursor: outOfRange })), rejects("DRAFT_VALIDATION"));
  assert.throws(() => draftId("../../private"), rejects("DRAFT_VALIDATION"));
  assert.equal(encodeDraftCursor(null), null);
});
test("actual JSON bytes are bounded even without Content-Length and malformed bodies fail closed", async () => {
  const create = (body, headers = {}) => new Request("http://localhost/api/admin/stories", { method: "POST", headers, body, duplex: "half" });
  const json = { "content-type": "application/json" };
  assert.deepEqual(await readDraftBody(create(JSON.stringify(content), json)), content);
  await assert.rejects(readDraftBody(create("{}", { "content-type": "text/plain" })), rejects("DRAFT_JSON_REQUIRED"));
  await assert.rejects(readDraftBody(create("{", json)), rejects("DRAFT_VALIDATION"));
  await assert.rejects(readDraftBody(create("{}", { ...json, "content-encoding": "gzip" })), rejects("DRAFT_JSON_REQUIRED"));
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(" ".repeat(DRAFT_BODY_LIMIT)));
    controller.enqueue(new TextEncoder().encode("{}")); controller.close();
  } });
  await assert.rejects(readDraftBody(create(stream, json)), rejects("DRAFT_BODY_TOO_LARGE"));
});
