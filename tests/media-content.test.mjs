import assert from "node:assert/strict";
import test from "node:test";
import { ContentValidationError, validateStoryContent } from "../src/server/stories/content.ts";
import { draftSave, DraftOperationError } from "../src/server/admin/drafts/policy.ts";
import { decodePublicStory } from "../src/lib/stories/public-client.ts";

const assetId = "abcd1234-1234-4321-abcd-123456789abc";
const image = { type: "image", assetId, alt: "合成图", caption: "合成说明" };
const document = (...blocks) => ({ version: 2, blocks });
const rejected = value => assert.throws(() => validateStoryContent(value), ContentValidationError);

test("v2 content round trips asset identity, plain text and styles without storage URLs", () => {
  const input = document({ type: "paragraph", text: "合成 <script> 普通文字", style: "emphasis" }, image,
    { type: "image", assetId: assetId.toUpperCase(), alt: "同一素材显式复用" });
  const result = validateStoryContent(input);
  assert.equal(result.version, 2);
  assert.equal(result.blocks[2].assetId, assetId);
  assert.notEqual(result.blocks, input.blocks);
  assert.deepEqual(Object.keys(result.blocks[1]).sort(), ["type", "assetId", "alt", "caption"].sort());
  const identity = { id: "12345678-1234-4321-abcd-123456789abc", slug: "synthetic-managed-story", title: "合成图文" };
  assert.deepEqual(decodePublicStory({ story: { ...identity, content: input } }, identity.id).content, result);
  assert.deepEqual(draftSave({ expectedVersion: 2, title: identity.title, content: input }).content, result);
});

test("v2 rejects src, storage keys, arbitrary URLs, extra fields and mixed image formats", () => {
  for (const block of [
    { ...image, src: "/scene/night-sky.webp" }, { ...image, storageKey: assetId },
    { ...image, url: "https://example.invalid/image.webp" }, { ...image, onerror: "alert(1)" },
    { type: "image", src: "/scene/night-sky.webp", alt: "旧图" },
    { ...image, assetId: "https://example.invalid/image.webp" },
    { ...image, assetId: "../private" }, { ...image, assetId: `%2f${assetId}` },
  ]) rejected(document(block));
  rejected(document(image, { type: "image", src: "/scene/night-sky.webp", alt: "旧图须显式替换" }));
  rejected({ version: 1, blocks: [image] });
  assert.throws(() => draftSave({ expectedVersion: 1, title: "合成", content: document({ ...image, src: "x" }) }), DraftOperationError);
});

test("v2 validates missing/null identifiers and labels plus bounded well-formed text", () => {
  for (const field of ["assetId", "alt"]) {
    const missing = { ...image }; delete missing[field];
    rejected(document(missing));
    for (const value of [undefined, null, "", "  ", 7]) rejected(document({ ...image, [field]: value }));
  }
  for (const value of [undefined, null, "", "  ", 7, "图".repeat(1001)]) rejected(document({ ...image, caption: value }));
  rejected(document({ ...image, alt: "图".repeat(301) }));
  for (const value of [undefined, null, "", " ", "x".repeat(10_001), "bad\0text", "\ud800"]) {
    rejected(document({ type: "paragraph", text: value }));
  }
  rejected(document({ type: "paragraph" }));
  assert.deepEqual(validateStoryContent(document({ type: "paragraph", text: "仅正文也可使用 v2。" })).version, 2);
});

test("v2 uses the PostgreSQL jsonb text byte boundary, including structural spaces", () => {
  const blocks = Array.from({ length: 30 }, () => ({ type: "paragraph", text: "x" }));
  // jsonb key order changes bytes' order, not their length. Explicit formatting
  // is an independent expected representation, including user comma/colon text.
  const pgText = () => `{"blocks": [${blocks.map(block => `{"text": ${JSON.stringify(block.text)}, "type": "paragraph"}`).join(", ")}], "version": 2}`;
  let remaining = 256 * 1024 - Buffer.byteLength(pgText());
  for (const block of blocks) {
    const extra = Math.min(9999, remaining); block.text += "x".repeat(extra); remaining -= extra;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(pgText()), 256 * 1024);
  assert.equal(validateStoryContent(document(...blocks)).blocks.length, 30);
  const last = blocks.at(-1); last.text += "x";
  assert.ok(Buffer.byteLength(JSON.stringify(document(...blocks))) < 256 * 1024);
  rejected(document(...blocks));
  assert.equal(validateStoryContent(document({ type: "paragraph", text: '标点 : , " \\ 与换行\n保留' })).blocks[0].text,
    '标点 : , " \\ 与换行\n保留');
});

test("legacy v1 remains readable and its draft image allowlist cannot bypass managed media", () => {
  const legacy = { version: 1, blocks: [{ type: "image", src: "/scene/night-sky.webp", alt: "合成旧图" }] };
  assert.deepEqual(draftSave({ expectedVersion: 0, title: "合成旧稿", content: legacy }).content, legacy);
  const remote = { version: 1, blocks: [{ type: "image", src: "https://example.invalid/legacy.webp", alt: "旧公开数据" }] };
  assert.deepEqual(validateStoryContent(remote), remote);
  assert.throws(() => draftSave({ expectedVersion: 0, title: "合成", content: remote }), DraftOperationError);
});
