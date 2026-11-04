import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, openEditor, editorReducer as reduce, validateDocument, toRevision, isDirty } from "../src/lib/admin-editor/state.ts";
import { createDraftApi } from "../src/lib/admin-editor/api.ts";
import { createPreviewSnapshot } from "../src/lib/admin-editor/preview.ts";
import { createMediaApi, parseMediaAsset, uploadMediaFile, MediaClientError } from "../src/lib/admin-editor/media-api.ts";

const id = "a1111111-1111-4111-8111-111111111111";
const another = "b2222222-2222-4222-8222-222222222222";
const storyId = "c3333333-3333-4333-8333-333333333333";
const metadata = { mimeType: "image/webp", width: 400, height: 240, byteLength: 1200, sha256: "a".repeat(64) };
const asset = { id, state: "READY", createdAt: "2026-11-03T12:00:00.000Z", publishedStoryCount: 0,
  display: metadata, thumbnail: metadata };
const summary = { id: storyId, slug: "story-synthetic-media", kind: "STAR", state: "DRAFT", version: 2,
  draftTitle: "合成素材草稿", hasUnpublishedChanges: true, updatedAt: "2026-11-03T12:00:00.000Z" };
const detail = { story: summary, draft: { title: summary.draftTitle,
  content: { version: 1, blocks: [{ type: "paragraph", text: "合成正文", style: "normal" },
    { type: "image", src: "/scene/night-sky.webp", alt: "原有说明", caption: "原有题注" }] } } };
const select = (state, blockKey = null, assetId = id, newBlockKey = "new-image") => reduce(state,
  { type: "select-media", instanceId: state.instanceId, blockKey, assetId, newBlockKey });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const errorKind = kind => error => error instanceof MediaClientError && error.kind === kind;

test("new text drafts use v2; editing legacy content preserves v1 without importing pictures", () => {
  const fresh = createEditor("STAR", "new");
  assert.equal(toRevision(fresh.working).content.version, 2);
  let legacy = openEditor(detail, "legacy");
  legacy = reduce(legacy, { type: "edit", document: { ...legacy.working, title: "新的标题" } });
  assert.equal(validateDocument(legacy.working), null);
  assert.equal(toRevision(legacy.working).content.version, 1);
  assert.deepEqual(toRevision(legacy.working).content.blocks[1], detail.draft.content.blocks[1]);
});

test("mixed migration keeps all pictures in preview but cannot save until explicit replacement", () => {
  let state = select(openEditor(detail, "migration"));
  assert.match(validateDocument(state.working), /逐一替换/);
  assert.equal(state.working.blocks.length, 3);
  assert.throws(() => toRevision(state.working), /Replace legacy/);
  assert.equal(isDirty(state), true);
  const preview = createPreviewSnapshot(state.working, true);
  assert.equal(preview.content.blocks[1].src, "/scene/night-sky.webp");
  assert.equal(preview.content.blocks[2].assetId, id);
  assert.equal(preview.content.version, 2);
  const oldKey = state.working.blocks[1].key;
  state = select(state, oldKey, another, "unused");
  assert.equal(state.working.blocks[1].key, oldKey);
  assert.equal(state.working.blocks[1].alt, "原有说明");
  assert.equal(state.working.blocks[1].caption, "原有题注");
  state = reduce(state, { type: "edit", document: { ...state.working,
    blocks: state.working.blocks.map(block => block.key === "new-image" ? { ...block, alt: "新图片说明" } : block) } });
  assert.equal(validateDocument(state.working), null);
  const payload = toRevision(state.working);
  assert.equal(payload.content.version, 2);
  assert.equal(JSON.stringify(payload).includes('"src"'), false);
  assert.equal(JSON.stringify(payload).includes('"key"'), false);
  assert.deepEqual(payload.content.blocks.filter(block => block.type === "image").map(block => block.assetId), [another, id]);
  assert.equal(state.confirmed.document.blocks[1].src, "/scene/night-sky.webp");
});

test("media selection is tied to editor instance and block identity, not array position", () => {
  const state = openEditor(detail, "current");
  const action = { type: "select-media", instanceId: "old-editor", blockKey: null, assetId: id, newBlockKey: "new" };
  assert.equal(reduce(state, action), state);
  assert.equal(reduce(state, { ...action, instanceId: state.instanceId, blockKey: "deleted-block" }), state);
  assert.equal(reduce(state, { ...action, instanceId: state.instanceId, blockKey: state.working.blocks[0].key }), state);
  const denied = reduce(state, { type: "access-denied" });
  assert.equal(select(denied), denied);
});

test("inserting while a save is in flight changes working only; old ACK never confirms the picture", () => {
  let state = openEditor(detail, "saving");
  state = reduce(state, { type: "edit", document: { ...state.working, title: "发送中的标题" } });
  state = reduce(state, { type: "begin-save", requestId: "save" });
  const sent = state.pending, confirmed = state.confirmed;
  state = select(state, state.working.blocks[1].key);
  assert.equal(state.pending, sent);
  assert.equal(state.lastSent, sent);
  assert.equal(state.confirmed, confirmed);
  assert.equal(state.pending.document.blocks[1].src, "/scene/night-sky.webp");
  state = reduce(state, { type: "save-ok", requestId: "save", story: { ...summary, version: 3, draftTitle: "发送中的标题" } });
  assert.equal(state.confirmed.document.blocks[1].src, "/scene/night-sky.webp");
  assert.equal(state.working.blocks[1].assetId, id);
  assert.equal(isDirty(state), true);
});

test("v2 draft read and reconciliation retain assetId; mixed and internal fields are rejected", async () => {
  const v2 = { story: summary, draft: { title: summary.draftTitle, content: { version: 2,
    blocks: [{ type: "image", assetId: id, alt: "合成配图", caption: "题注" }] } } };
  assert.deepEqual(await createDraftApi(async () => json(v2)).get(storyId), v2);
  let state = openEditor(detail, "reconcile");
  state = reduce(state, { type: "remote-read", detail: v2 });
  state = reduce(state, { type: "use-remote" });
  assert.equal(state.working.contentVersion, 2);
  assert.equal(toRevision(state.working).content.blocks[0].assetId, id);
  for (const image of [{ type: "image", src: "/scene/night-sky.webp", alt: "旧图" },
    { ...v2.draft.content.blocks[0], storageKey: "private-storage" }]) {
    await assert.rejects(createDraftApi(async () => json({ ...v2, draft: { ...v2.draft,
      content: { version: 2, blocks: [image] } } })).get(storyId), error => error.kind === "retryable");
  }
});

test("asset preview freezes content while excluding editor, storage and persistence fields", () => {
  const document = { kind: "STAR", title: "预览", contentVersion: 2, blocks: [
    { type: "image", key: "local", assetId: id, alt: "说明", caption: "题注", storageKey: "private-key", storyId: "draft-id" },
  ] };
  const snapshot = createPreviewSnapshot(document, true);
  assert.deepEqual(snapshot.content.blocks[0], { type: "image", assetId: id, alt: "说明", caption: "题注" });
  assert.ok(Object.isFrozen(snapshot.content.blocks[0]));
  document.blocks[0].assetId = another;
  assert.equal(snapshot.content.blocks[0].assetId, id);
  assert.equal(JSON.stringify(snapshot).includes("private-key"), false);
});

test("media DTO allowlist rejects internal fields and inconsistent readiness", () => {
  assert.deepEqual(parseMediaAsset(asset), asset);
  assert.equal(parseMediaAsset({ ...asset, publishedStoryCount: 2 }).publishedStoryCount, 2);
  for (const bad of [{ ...asset, storageKey: "private-key" }, { ...asset, publishedStoryCount: -1 },
    { ...asset, state: "PENDING" }, { ...asset, display: { ...metadata, width: 0 } },
    { ...asset, thumbnail: { ...metadata, filesystemPath: "private-path" } }]) assert.throws(() => parseMediaAsset(bad));
});

test("media status recovery queries the same UUID with no-store credentials and never posts", async () => {
  const calls = [];
  const api = createMediaApi(async (url, options) => { calls.push({ url, options }); return json(url.includes("?")
    ? { items: [asset], nextCursor: null } : { asset }); });
  assert.deepEqual((await api.list()).items, [asset]);
  assert.equal((await api.get(id)).id, id);
  assert.equal(calls[1].url, `/api/admin/media/${id}`);
  for (const { options } of calls) {
    assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error"); assert.equal(options.method, undefined); assert.equal(options.body, undefined);
  }
  await assert.rejects(createMediaApi(async () => json({}, 404)).get(id), errorKind("not-found"));
  await assert.rejects(createMediaApi(async () => json({ asset: { ...asset, id: another } })).get(id), errorKind("unavailable"));
});

function fakeXhr() {
  return { upload: {}, headers: {}, sends: 0, status: 201, responseText: JSON.stringify({ asset }),
    open(method, url) { this.method = method; this.url = url; },
    setRequestHeader(name, value) { this.headers[name] = value; },
    getResponseHeader() { return "application/json"; },
    send(body) { this.body = body; this.sends += 1; } };
}
const file = () => new globalThis.File([new Uint8Array([1, 2, 3])], "synthetic.png", { type: "image/png" });

test("binary XHR distinguishes actual byte progress, processing and confirmed READY", async () => {
  const xhr = fakeXhr(), progress = [];
  let processing = false, completed = false;
  const input = file();
  const operation = uploadMediaFile(input, id, value => progress.push(value), () => { processing = true; }, () => xhr)
    .then(result => { completed = true; return result; });
  assert.equal(xhr.method, "POST"); assert.equal(xhr.url, "/api/admin/media"); assert.equal(xhr.sends, 1);
  assert.equal(xhr.body, input); assert.equal(xhr.headers["Idempotency-Key"], id);
  assert.equal(xhr.headers["Content-Type"], "image/png");
  xhr.upload.onprogress({ lengthComputable: true, loaded: 2, total: 5 });
  assert.deepEqual(progress, [40]); assert.equal(processing, false);
  xhr.upload.onload(); await Promise.resolve();
  assert.equal(processing, true); assert.equal(completed, false);
  xhr.onload(); assert.equal((await operation).state, "READY");
});

test("XHR lost responses and server uncertainty never resend; raw errors are not surfaced", async () => {
  for (const failure of ["error", "timeout", "abort", 503, 409, "malformed"]) {
    const xhr = fakeXhr();
    const operation = uploadMediaFile(file(), id, () => {}, () => {}, () => xhr);
    if (typeof failure === "number") { xhr.status = failure; xhr.responseText = "private-database-detail"; xhr.onload(); }
    else if (failure === "malformed") { xhr.responseText = JSON.stringify({ asset: { ...asset, storageKey: "private-key" } }); xhr.onload(); }
    else xhr[`on${failure}`]();
    await assert.rejects(operation, error => errorKind("uncertain")(error) && !error.message.includes("private-"));
    assert.equal(xhr.sends, 1);
  }
});

test("invalid files are rejected before XHR creation and permission errors remain distinct", async () => {
  for (const input of [new globalThis.File(["svg"], "synthetic.svg", { type: "image/svg+xml" }),
    new globalThis.File([new Uint8Array(3 * 1024 * 1024 + 1)], "synthetic.png", { type: "image/png" })]) {
    await assert.rejects(uploadMediaFile(input, id, () => {}, () => {}, () => { assert.fail("No request expected"); }), errorKind("invalid"));
  }
  const xhr = fakeXhr();
  const operation = uploadMediaFile(file(), id, () => {}, () => {}, () => xhr);
  xhr.status = 403; xhr.onload();
  await assert.rejects(operation, errorKind("denied"));
});
