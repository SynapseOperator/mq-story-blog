import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewSnapshot } from "../src/lib/admin-editor/preview.ts";
import { createEditor, openEditor, editorReducer as reduce, isDirty, canSave,
  validateDocument } from "../src/lib/admin-editor/state.ts";

const detail = {
  story: { id: "1a9527ef-8afb-4116-8d44-bcb4a6d50100", slug: "story-synthetic-preview",
    kind: "STAR", state: "DRAFT", version: 4, draftTitle: "已保存合成标题",
    hasUnpublishedChanges: true, updatedAt: "2026-11-03T12:00:00.000Z" },
  draft: { title: "已保存合成标题", content: { version: 1, blocks: [{ type: "paragraph", text: "已保存合成正文" }] } },
};
const edit = (state, title, text) => reduce(state, { type: "edit", document: {
  ...state.working, title, blocks: [{ ...state.working.blocks[0], text }] } });

test("preview freezes an independent snapshot without freezing the working document", () => {
  const document = { kind: "STAR", title: "合成预览", blocks: [
    { key: "p1", type: "paragraph", text: "当前段落", style: "emphasis" },
    { key: "i1", type: "image", src: "/scene/night-sky.webp", alt: "合成星空", caption: "原始题注" },
  ] };
  const snapshot = createPreviewSnapshot(document, true);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.content));
  assert.ok(Object.isFrozen(snapshot.content.blocks));
  assert.ok(snapshot.content.blocks.every(Object.isFrozen));
  assert.notEqual(snapshot.content.blocks, document.blocks);
  assert.notEqual(snapshot.content.blocks[0], document.blocks[0]);
  assert.throws(() => { snapshot.title = "changed"; }, TypeError);
  assert.throws(() => { snapshot.content.blocks[0].text = "changed"; }, TypeError);
  assert.throws(() => { snapshot.content.blocks.push({ type: "paragraph", text: "changed" }); }, TypeError);
  document.title = "打开预览后的标题";
  document.blocks[0].text = "后续本地编辑";
  document.blocks[1].caption = "后续题注";
  document.blocks.reverse();
  assert.equal(snapshot.title, "合成预览");
  assert.equal(snapshot.content.blocks[0].text, "当前段落");
  assert.equal(snapshot.content.blocks[1].caption, "原始题注");
});

test("new STAR and CAMPFIRE previews accept empty titles and incomplete content without save validation", () => {
  for (const kind of ["STAR", "CAMPFIRE"]) {
    const state = createEditor(kind, `new-${kind}`);
    assert.notEqual(validateDocument(state.working), null);
    assert.equal(canSave(state), false);
    const snapshot = createPreviewSnapshot(state.working, false);
    assert.equal(snapshot.title, "");
    assert.deepEqual(snapshot.content.blocks, [{ type: "paragraph", text: "", style: "normal" }]);
    assert.equal(snapshot.hasUnsavedChanges, false);
    assert.deepEqual(createPreviewSnapshot({ ...state.working, blocks: [] }, true).content.blocks, []);
    assert.deepEqual(createPreviewSnapshot({ ...state.working, blocks: [
      { key: "unfinished-image", type: "image", src: "/scene/night-sky.webp", alt: "", caption: "" },
    ] }, true).content.blocks, [{ type: "image", src: "/scene/night-sky.webp", alt: "", caption: "" }]);
    assert.equal(state.confirmed, null);
    assert.equal(state.pending, null);
  }
});

test("preview preserves mixed block order, every style, image fields and entered whitespace", () => {
  const blocks = [
    { type: "paragraph", text: "  普通段落\n", style: "normal" },
    { type: "image", src: "/scene/night-sky.webp", alt: " 合成图片说明 ", caption: "  " },
    { type: "paragraph", text: "强调", style: "emphasis" },
    { type: "paragraph", text: "加粗", style: "strong" },
    { type: "image", src: "/scene/missing-synthetic.webp", alt: "失效图片" },
    { type: "paragraph", text: "<script>合成文字仅为普通文本</script>" },
  ];
  const snapshot = createPreviewSnapshot({ kind: "STAR", title: "  未规范化标题  ",
    blocks: blocks.map((block, index) => ({ key: `block-${index}`, ...block })) }, true);
  assert.equal(snapshot.title, "  未规范化标题  ");
  assert.deepEqual(snapshot.content.blocks, blocks);
  assert.equal(snapshot.hasUnsavedChanges, true);
});

test("preview's explicit field whitelist excludes editing and persistence metadata", () => {
  const snapshot = createPreviewSnapshot({ kind: "CAMPFIRE", title: "合成标题", id: "private-id",
    slug: "private-slug", version: 99, publishedRevisionId: "private-revision", blocks: [
      { key: "private-key", type: "paragraph", text: "正文", style: "strong", html: "private-html", storyId: "private-id" },
      { key: "image-key", type: "image", src: "/scene/night-sky.webp", alt: "说明", caption: "题注", version: 99 },
    ] }, true);
  assert.deepEqual(Object.keys(snapshot).sort(), ["content", "hasUnsavedChanges", "title"]);
  assert.deepEqual(Object.keys(snapshot.content).sort(), ["blocks", "version"]);
  assert.equal(snapshot.content.version, 1);
  assert.deepEqual(Object.keys(snapshot.content.blocks[0]).sort(), ["style", "text", "type"]);
  assert.deepEqual(Object.keys(snapshot.content.blocks[1]).sort(), ["alt", "caption", "src", "type"]);
  assert.ok(!JSON.stringify(snapshot).includes("private-"));
});

test("preview during save uses current working text and leaves the sent and confirmed snapshots untouched", () => {
  let state = edit(openEditor(detail, "saved-editor"), "发送标题", "发送正文");
  state = reduce(state, { type: "begin-save", requestId: "save-one" });
  state = edit(state, "保存期间继续输入的标题", "保存期间继续输入的正文");
  const before = globalThis.structuredClone(state);
  const sent = state.pending;
  const confirmed = state.confirmed;
  const snapshot = createPreviewSnapshot(state.working, isDirty(state));
  assert.equal(snapshot.title, "保存期间继续输入的标题");
  assert.equal(snapshot.content.blocks[0].text, "保存期间继续输入的正文");
  assert.equal(snapshot.hasUnsavedChanges, true);
  assert.deepEqual(state, before);
  assert.equal(state.pending, sent);
  assert.equal(state.confirmed, confirmed);
  assert.equal(state.pending.expectedVersion, 4);
  state = reduce(state, { type: "save-ok", requestId: "save-one",
    story: { ...detail.story, version: 5, draftTitle: "发送标题" } });
  assert.equal(state.confirmed.document.title, "发送标题");
  assert.equal(state.working.title, snapshot.title);
  assert.equal(isDirty(state), true);
});

test("preview after conflict or unknown save result does not reconcile, retry or clear local changes", () => {
  for (const kind of ["conflict", "uncertain"]) {
    let state = edit(openEditor(detail, `failure-${kind}`), "保留的本地标题", "保留的本地正文");
    state = reduce(state, { type: "begin-save", requestId: "failed-save" });
    state = reduce(state, { type: "save-error", requestId: "failed-save", kind, message: `合成 ${kind}` });
    const before = globalThis.structuredClone(state);
    const snapshot = createPreviewSnapshot(state.working, isDirty(state));
    assert.equal(snapshot.title, "保留的本地标题");
    assert.equal(snapshot.content.blocks[0].text, "保留的本地正文");
    assert.deepEqual(state, before);
    assert.equal(state.status, kind);
    assert.equal(state.confirmed.story.version, 4);
    assert.equal(state.lastSent.expectedVersion, 4);
    assert.equal(canSave(state), false);
    assert.equal(isDirty(state), true);
  }
});
