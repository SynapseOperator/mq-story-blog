import assert from "node:assert/strict";
import test from "node:test";
import { createDraftApi, DraftClientError } from "../src/lib/admin-editor/api.ts";
import { createEditor, openEditor, editorReducer as reduce, isDirty, canSave, needsLeaveProtection,
  validateDocument, toRevision, imageBlock } from "../src/lib/admin-editor/state.ts";

const id = "1a9527ef-8afb-4116-8d44-bcb4a6d50100";
const otherId = "1a9527ef-8afb-4116-8d44-bcb4a6d50101";
const summary = (overrides = {}) => ({ id, slug: "story-synthetic", kind: "STAR", state: "DRAFT", version: 0,
  draftTitle: "合成测试草稿", hasUnpublishedChanges: true, updatedAt: "2026-10-29T12:00:00.000Z", ...overrides });
const detail = (overrides = {}, text = "合成段落") => ({ story: summary(overrides),
  draft: { title: overrides.draftTitle ?? "合成测试草稿", content: { version: 1, blocks: [{ type: "paragraph", text }] } } });
const edit = (state, title = "合成修改", text = "本地内容") => reduce(state, { type: "edit", document: {
  ...state.working, title, blocks: [{ ...state.working.blocks[0], text }] } });
const begin = (state, requestId = "request-1") => reduce(state, { type: "begin-save", requestId });
const fail = (state, kind, requestId = "request-1") => reduce(state, { type: "save-error", requestId, kind, message: `测试 ${kind}` });
const json = (body, status = 200) => Response.json(body, { status });
const errorIs = kind => error => error instanceof DraftClientError && error.kind === kind;

test("ACK confirms only the immutable sent snapshot; typing during save remains dirty", () => {
  const initial = openEditor(detail(), "editor-one");
  let state = begin(edit(initial));
  const sent = state.pending;
  assert.ok(Object.isFrozen(sent));
  assert.ok(Object.isFrozen(sent.document.blocks[0]));
  assert.throws(() => { sent.document.blocks[0].text = "changed"; }, TypeError);
  state = edit(state, "保存期间的新标题", "保存期间的新正文");
  state = reduce(state, { type: "save-ok", requestId: "request-1", story: summary({ version: 1, draftTitle: "合成修改" }) });
  assert.equal(state.working.title, "保存期间的新标题");
  assert.equal(state.confirmed.document.title, "合成修改");
  assert.equal(state.confirmed.story.version, 1);
  assert.equal(state.lastSent, sent);
  assert.equal(isDirty(state), true);
  assert.equal(canSave(state), true);
  state = begin(state, "request-2");
  assert.equal(state.pending.expectedVersion, 1);
  assert.equal(state.pending.document.blocks[0].text, "保存期间的新正文");
});

test("pending write protects navigation even if user reverses edits to the previous baseline", () => {
  const initial = openEditor(detail(), "editor-one");
  let state = begin(edit(initial));
  state = reduce(state, { type: "edit", document: initial.working });
  assert.equal(isDirty(state), false);
  assert.equal(needsLeaveProtection(state), true);
  assert.equal(canSave(state), false);
  state = reduce(state, { type: "save-ok", requestId: "request-1", story: summary({ version: 1, draftTitle: "合成修改" }) });
  assert.equal(isDirty(state), true);
  assert.equal(state.working.title, initial.working.title);
});

test("stale ACK/errors and overlapping save attempts cannot replace a newer document", () => {
  let state = begin(edit(openEditor(detail(), "editor-one")));
  assert.equal(begin(state, "request-2"), state);
  assert.equal(reduce(state, { type: "save-ok", requestId: "old", story: summary({ version: 1 }) }), state);
  assert.equal(fail(state, "denied", "old"), state);
  state = openEditor(detail({ id: otherId }), "editor-two");
  assert.equal(reduce(state, { type: "save-ok", requestId: "request-1", story: summary({ version: 1 }) }), state);
  assert.equal(state.confirmed.story.id, otherId);
});

test("409 preserves local content and CAS version until explicit reconciliation", () => {
  let state = fail(begin(edit(openEditor(detail(), "editor-one"))), "conflict");
  assert.equal(canSave(state), false);
  const local = state.working;
  state = reduce(state, { type: "remote-read", detail: detail({ version: 7, draftTitle: "另一编辑者的标题" }, "另一编辑者内容") });
  assert.equal(state.working, local);
  assert.equal(state.confirmed.story.version, 0);
  assert.equal(canSave(state), false);
  state = reduce(state, { type: "keep-local" });
  assert.equal(state.working, local);
  assert.equal(state.confirmed.story.version, 7);
  assert.equal(canSave(state), true);
  state = begin(state, "request-2");
  assert.equal(state.pending.expectedVersion, 7);
  assert.equal(state.pending.document.title, local.title);
});

test("uncertain POST cannot be repeated; manual adoption binds a checked candidate without losing newer local text", () => {
  let state = fail(begin(edit(createEditor("STAR", "new-editor"))), "uncertain");
  state = edit(state, "创建响应丢失后的编辑", "继续写的内容");
  assert.equal(state.confirmed, null);
  assert.equal(canSave(state), false);
  assert.equal(begin(state, "duplicate-create"), state);
  assert.equal(reduce(state, { type: "remote-read", detail: detail({ kind: "CAMPFIRE" }) }), state);
  state = reduce(state, { type: "remote-read", detail: detail({ version: 2 }) });
  assert.equal(state.confirmed, null);
  assert.equal(canSave(state), false);
  state = reduce(state, { type: "keep-local" });
  assert.equal(state.confirmed.story.id, id);
  assert.equal(state.working.title, "创建响应丢失后的编辑");
  state = begin(state, "request-2");
  assert.equal(state.pending.storyId, id);
  assert.equal(state.pending.expectedVersion, 2);
});

test("unknown PUT does not adopt a reread version automatically; explicit use-remote discards only after consent", () => {
  let state = fail(begin(edit(openEditor(detail(), "editor-one"))), "uncertain");
  const unchanged = reduce(state, { type: "remote-read", detail: detail({ id: otherId }) });
  assert.equal(unchanged, state);
  state = reduce(state, { type: "remote-read", detail: detail({ version: 1, draftTitle: "已确认服务器版本" }, "已经保存的正文") });
  assert.equal(state.working.title, "合成修改");
  assert.equal(state.confirmed.story.version, 0);
  state = reduce(state, { type: "use-remote" });
  assert.equal(state.working.title, "已确认服务器版本");
  assert.equal(state.confirmed.story.version, 1);
  assert.equal(isDirty(state), false);
  assert.equal(needsLeaveProtection(state), false);
});

test("400 and access loss preserve content; denied state never enables saving", () => {
  for (const kind of ["validation", "denied", "retryable"]) {
    let state = begin(edit(openEditor(detail(), `editor-${kind}`)));
    const local = state.working;
    state = fail(state, kind);
    assert.equal(state.working, local);
    assert.equal(state.confirmed.story.version, 0);
    assert.equal(canSave(state), kind !== "denied");
    assert.equal(needsLeaveProtection(state), true);
  }
});

test("wrong story/version ACK is uncertain, never authoritative", () => {
  const state = begin(edit(openEditor(detail(), "editor-one")));
  for (const patch of [{ id: otherId }, { version: 3 }, { kind: "CAMPFIRE" }, { draftTitle: "wrong title" }]) {
    const next = reduce(state, { type: "save-ok", requestId: "request-1", story: summary({ version: 1, draftTitle: "合成修改", ...patch }) });
    assert.equal(next.status, "uncertain");
    assert.equal(next.confirmed.story.version, 0);
    assert.equal(next.working, state.working);
  }
});

test("read-side permission loss preserves local draft but blocks subsequent writes", () => {
  const state = edit(openEditor(detail(), "editor-one"));
  const denied = reduce(state, { type: "access-denied" });
  assert.equal(denied.working, state.working);
  assert.equal(denied.confirmed, state.confirmed);
  assert.equal(denied.status, "denied");
  assert.equal(canSave(denied), false);
  assert.equal(begin(denied), denied);
  const edited = edit(denied, "权限失效后继续整理的本地文本");
  assert.equal(edited.status, "denied");
  assert.equal(canSave(edited), false);
  const pending = begin(state);
  assert.equal(reduce(pending, { type: "access-denied" }), pending);
});

test("semantic normalization, stable block keys and ordering produce accurate dirty state", () => {
  let state = openEditor(detail(), "editor-one");
  state = reduce(state, { type: "edit", document: { ...state.working, title: "  合成测试草稿  ",
    blocks: [{ ...state.working.blocks[0], key: "different-local-key", style: "normal" }] } });
  assert.equal(isDirty(state), false);
  state = reduce(state, { type: "edit", document: { ...state.working, blocks: [
    ...state.working.blocks, imageBlock("image-two"), { type: "paragraph", key: "three", text: "第二段" },
  ] } });
  assert.equal(validateDocument(state.working), null);
  const payload = toRevision(state.working);
  assert.equal(Object.hasOwn(payload.content.blocks[0], "key"), false);
  assert.equal(Object.hasOwn(payload.content.blocks[1], "caption"), false);
  const keys = state.working.blocks.map(block => block.key);
  state = reduce(state, { type: "edit", document: { ...state.working, blocks: state.working.blocks.toReversed() } });
  assert.deepEqual(state.working.blocks.map(block => block.key), keys.toReversed());
  assert.equal(isDirty(state), true);
});

test("local validation rejects unsupported image refs, duplicate keys, invalid paragraph style and content bounds", () => {
  const valid = edit(createEditor("STAR", "new")).working;
  assert.equal(validateDocument(valid), null);
  for (const document of [
    { ...valid, blocks: [] },
    { ...valid, title: " " },
    { ...valid, blocks: [{ type: "image", key: "a", src: "https://example.com/private.png", alt: "x" }] },
    { ...valid, blocks: [valid.blocks[0], valid.blocks[0]] },
    { ...valid, blocks: [{ ...valid.blocks[0], style: "html" }] },
    { ...valid, blocks: [{ ...valid.blocks[0], text: "x".repeat(10001) }] },
    { ...valid, blocks: Array.from({ length: 30 }, (_, i) => ({ ...valid.blocks[0], key: String(i), text: "中".repeat(4000) })) },
  ]) assert.equal(typeof validateDocument(document), "string");
});

test("client sends exact whitelisted DTO, same-origin credentials and no cache; no local keys escape", async () => {
  const calls = [];
  const api = createDraftApi(async (url, init) => {
    calls.push({ url, init });
    return json({ story: summary({ draftTitle: "合成修改", version: init.method === "PUT" ? 3 : 0 }) });
  });
  const document = edit(createEditor("STAR", "local-only")).working;
  assert.equal((await api.create(document)).id, id);
  assert.equal((await api.save(id, 2, document)).version, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/admin/stories");
  assert.equal(calls[1].url, `/api/admin/stories/${id}/draft`);
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "error");
  const create = JSON.parse(calls[0].init.body), save = JSON.parse(calls[1].init.body);
  assert.deepEqual(Object.keys(create).sort(), ["kind", "title", "content"].sort());
  assert.deepEqual(Object.keys(save).sort(), ["expectedVersion", "title", "content"].sort());
  assert.equal(save.expectedVersion, 2);
  assert.equal(calls[0].init.body.includes("local-only"), false);
});

test("client accepts only valid detail/list DTOs and guards unrelated response identity", async () => {
  const api = createDraftApi(async url => json(url.includes("?limit") ? { items: [summary()], nextCursor: null } : detail()));
  assert.deepEqual(await api.get(id), detail());
  assert.deepEqual(await api.list(), { items: [summary()], nextCursor: null });
  await assert.rejects(api.get(otherId), errorIs("retryable"));
  let called = false;
  const guarded = createDraftApi(async () => { called = true; return json(detail()); });
  await assert.rejects(guarded.get("../../auth/session"), errorIs("validation"));
  await assert.rejects(guarded.list("../token"), errorIs("validation"));
  assert.equal(called, false);
});

test("unexpected internal fields and malformed success never become editor data or raw errors", async () => {
  const secret = "synthetic-internal-email@accounts.invalid";
  const document = edit(createEditor("STAR", "new")).working;
  for (const result of [
    { story: { ...summary(), email: secret } },
    { story: { ...summary(), version: -1 } },
    { story: summary(), sessionToken: secret },
  ]) {
    const api = createDraftApi(async () => json(result));
    await assert.rejects(api.create(document), error => errorIs("uncertain")(error) && !error.message.includes(secret));
  }
  const invalidDetail = detail();
  invalidDetail.draft.content.blocks = [{ type: "html", text: "<script>bad</script>" }];
  await assert.rejects(createDraftApi(async () => json(invalidDetail)).get(id), errorIs("retryable"));
});

test("network/503/invalid success writes remain uncertain and are sent exactly once", async () => {
  const document = edit(createEditor("STAR", "new")).working;
  for (const result of ["network", "503", "invalid-json"]) {
    let calls = 0;
    const api = createDraftApi(async () => {
      calls += 1;
      if (result === "network") throw new Error("sensitive transport detail");
      if (result === "503") return json({ error: "sensitive database detail" }, 503);
      return new Response("not JSON", { headers: { "content-type": "application/json" } });
    });
    await assert.rejects(api.create(document), errorIs("uncertain"));
    assert.equal(calls, 1);
    await assert.rejects(api.save(id, 0, document), errorIs("uncertain"));
    assert.equal(calls, 2);
  }
});

test("known HTTP rejections are distinct from unknown commit outcomes and read cancellation", async () => {
  const document = edit(createEditor("STAR", "new")).working;
  for (const [status, kind] of [[400, "validation"], [409, "conflict"], [401, "denied"], [403, "denied"], [429, "retryable"]]) {
    await assert.rejects(createDraftApi(async () => json({ error: "not forwarded" }, status)).create(document), error =>
      errorIs(kind)(error) && error.status === status && !error.message.includes("not forwarded"));
  }
  const signal = AbortSignal.abort();
  const api = createDraftApi(async () => { throw new Error("abort"); });
  await assert.rejects(api.get(id, signal), errorIs("cancelled"));
  await assert.rejects(api.get(id), errorIs("retryable"));
});
