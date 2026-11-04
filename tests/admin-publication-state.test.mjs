import assert from "node:assert/strict";
import test from "node:test";
import { createEditor, openEditor, editorReducer as reduce, canSave, canPublishAction, isDirty, needsLeaveProtection } from "../src/lib/admin-editor/state.ts";
import { createPublicationApi, PublicationClientError } from "../src/lib/admin-editor/publication-api.ts";
import { DraftClientError } from "../src/lib/admin-editor/api.ts";

const id = "0de195b0-2a39-4b4e-9b87-b0ee6586fc53";
const otherId = "0de195b0-2a39-4b4e-9b87-b0ee6586fc54";
const detail = (overrides = {}, text = "合成已保存段落") => ({
  story: { id, slug: "story-publication-test", kind: "STAR", state: "DRAFT", version: 2,
    draftTitle: "合成故事", hasUnpublishedChanges: true, updatedAt: "2026-11-04T12:00:00.000Z", ...overrides },
  draft: { title: "合成故事", content: { version: 2, blocks: [{ type: "paragraph", text }] } },
});
const edit = state => reduce(state, { type: "edit", document: { ...state.working, title: "尚未保存的本地标题" } });
const begin = (state, action = "publish", slotId) => reduce(state, { type: "begin-publication", requestId: "publication-one", action, slotId });
const ack = (overrides = {}) => ({ id, version: 3, state: "PUBLISHED", slotId: "star-1", hasUnpublishedChanges: false, ...overrides });
const success = (state, story = ack()) => reduce(state, { type: "publication-ok", requestId: "publication-one", story });
const failure = (state, kind) => reduce(state, { type: "publication-error", requestId: "publication-one", kind, message: `合成 ${kind}` });
const errorIs = kind => error => error instanceof PublicationClientError && error instanceof DraftClientError && error.kind === kind;

test("new and dirty drafts must be saved before publication; slot choice is separate", () => {
  const fresh = createEditor("STAR", "fresh");
  for (const action of ["slot", "publish", "withdraw", "restore"]) assert.equal(canPublishAction(fresh, action), false);
  const saved = openEditor(detail(), "saved");
  assert.equal(canPublishAction(saved, "publish"), true);
  assert.equal(canPublishAction(edit(saved), "publish"), false);
  assert.equal(canPublishAction(edit(saved), "slot"), true);
  assert.equal(canPublishAction(openEditor(detail({ kind: "CAMPFIRE" })), "slot"), false);
  assert.equal(canPublishAction(openEditor(detail({ state: "PUBLISHED", hasUnpublishedChanges: false })), "publish"), false);
  assert.equal(canPublishAction(openEditor(detail({ state: "WITHDRAWN" })), "publish"), false);
});

test("publication ACK advances only metadata, preserving typing, keys and the confirmed document", () => {
  const original = openEditor(detail(), "editor-one");
  let state = begin(original);
  assert.ok(Object.isFrozen(state.publication));
  assert.equal(state.lastSent, null); assert.equal(state.pending, null);
  assert.equal(needsLeaveProtection(state), true);
  assert.equal(canSave(state), false);
  state = edit(state);
  const working = state.working;
  state = success(state);
  assert.equal(state.working, working);
  assert.equal(state.confirmed.document, original.confirmed.document);
  assert.equal(state.confirmed.story.updatedAt, original.confirmed.story.updatedAt);
  assert.equal(state.confirmed.story.version, 3);
  assert.equal(state.confirmed.story.state, "PUBLISHED");
  assert.equal(state.confirmed.story.hasUnpublishedChanges, false);
  assert.equal(isDirty(state), true); assert.equal(canSave(state), true);
  assert.equal(canPublishAction(state, "publish"), false);
});

test("saving and publication cannot overlap; late reads cannot replace an in-flight publication", () => {
  const publishing = begin(openEditor(detail()));
  assert.equal(reduce(publishing, { type: "begin-save", requestId: "save" }), publishing);
  assert.equal(begin(publishing), publishing);
  assert.equal(reduce(publishing, { type: "remote-read", detail: detail({ version: 4 }) }), publishing);
  assert.equal(reduce(publishing, { type: "access-denied" }), publishing);
  const saving = reduce(edit(openEditor(detail())), { type: "begin-save", requestId: "save" });
  assert.equal(begin(saving, "slot", "star-1"), saving);
});

test("publication response IDs and versions correlate to one pending operation", () => {
  const pending = begin(openEditor(detail()));
  assert.equal(reduce(pending, { type: "publication-ok", requestId: "late", story: ack() }), pending);
  for (const patch of [{ id: otherId }, { version: 2 }, { version: 4 }, { state: "WITHDRAWN" }, { hasUnpublishedChanges: true }]) {
    const next = success(pending, ack(patch));
    assert.equal(next.status, "uncertain"); assert.equal(next.publication, null);
    assert.equal(next.confirmed, pending.confirmed); assert.equal(next.working, pending.working);
    assert.equal(canSave(next), false); assert.equal(canPublishAction(next, "publish"), false);
  }
});

test("slot selection advances CAS without saving or discarding local text", () => {
  const local = edit(openEditor(detail()));
  assert.equal(begin(local, "slot"), local);
  const pending = begin(local, "slot", "star-2");
  assert.equal(success(pending, ack({ state: "DRAFT", slotId: "star-1", hasUnpublishedChanges: true })).status, "uncertain");
  let state = success(pending, ack({ state: "DRAFT", slotId: "star-2", hasUnpublishedChanges: true }));
  assert.equal(state.working, local.working); assert.equal(isDirty(state), true);
  state = reduce(state, { type: "begin-save", requestId: "save-after-slot" });
  assert.equal(state.pending.expectedVersion, 3); assert.equal(state.lastPublication, null);
});

test("withdraw and restore retain unsaved edits and unpublished-draft status", () => {
  let state = edit(openEditor(detail({ state: "PUBLISHED" })));
  const working = state.working, document = state.confirmed.document;
  state = success(begin(state, "withdraw"), ack({ state: "WITHDRAWN", hasUnpublishedChanges: true }));
  assert.equal(state.confirmed.story.state, "WITHDRAWN");
  assert.equal(canPublishAction(state, "slot"), false);
  state = success(begin(state, "restore"), ack({ version: 4, hasUnpublishedChanges: true }));
  assert.equal(state.confirmed.story.state, "PUBLISHED"); assert.equal(state.confirmed.story.hasUnpublishedChanges, true);
  assert.equal(state.working, working); assert.equal(state.confirmed.document, document); assert.equal(isDirty(state), true);
});

test("conflict and unknown publication results require explicit reconciliation and preserve input", () => {
  for (const kind of ["conflict", "uncertain"]) {
    const pending = edit(begin(openEditor(detail())));
    let state = failure(pending, kind);
    assert.equal(state.status, kind); assert.equal(state.lastPublication.action, "publish");
    assert.equal(state.working, pending.working); assert.equal(state.confirmed, pending.confirmed);
    assert.equal(canSave(state), false); assert.equal(canPublishAction(state, "publish"), false);
    assert.equal(needsLeaveProtection(state), true);
    state = reduce(state, { type: "remote-read", detail: detail({ version: 7, state: "PUBLISHED" }, "其他窗口已保存内容") });
    assert.equal(state.confirmed.story.version, 2);
    state = reduce(state, { type: "keep-local" });
    assert.equal(state.working, pending.working); assert.equal(state.confirmed.story.version, 7);
    assert.equal(state.lastPublication, null); assert.equal(isDirty(state), true);
    assert.equal(canPublishAction(state, "publish"), false); assert.equal(canSave(state), true);
  }
});

test("permission loss and validation errors retain input without repeating a request", () => {
  const pending = edit(begin(openEditor(detail())));
  const denied = failure(pending, "denied");
  assert.equal(denied.status, "denied"); assert.equal(denied.working, pending.working);
  assert.equal(canSave(denied), false); assert.equal(canPublishAction(denied, "withdraw"), false);
  const invalid = failure(pending, "validation");
  assert.equal(invalid.status, "ready"); assert.equal(invalid.working, pending.working);
  assert.equal(invalid.publication, null);
  assert.equal(failure(invalid, "uncertain"), invalid);
});

test("publication client sends only the existing safe parameters and never private proof fields", async () => {
  const calls = [];
  const api = createPublicationApi(async (path, init) => { calls.push([path, init]); return Response.json({ story: ack() }); });
  for (const action of ["publish", "withdraw", "restore"]) await api.apply(id, action, 2);
  await api.apply(id, "slot", 2, "star-1"); await api.apply(id, "slot", 2, null);
  for (const [index, [path, init]] of calls.entries()) {
    assert.ok(path.startsWith(`/api/admin/stories/${id}/`));
    assert.equal(init.method, index < 3 ? "POST" : "PUT");
    assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store"); assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(init.body), index < 3 ? { expectedVersion: 2 } : { expectedVersion: 2, slotId: index === 3 ? "star-1" : null });
  }
});

test("publication client rejects invalid outbound operations before HTTP", async () => {
  let calls = 0;
  const api = createPublicationApi(async () => { calls++; return Response.json({ story: ack() }); });
  for (const args of [[otherId + "/publish", "publish", 2], [id, "owner", 2], [id, "publish", -1],
    [id, "publish", 2, "star-1"], [id, "slot", 2], [id, "slot", 2, "../private"], [id, "publish", { role: "admin" }]]) {
    await assert.rejects(api.apply(...args), errorIs("validation"));
  }
  assert.equal(calls, 0);
});

test("slot response preserves occupied states but rejects hidden fields and duplicate identities", async () => {
  const slot = { id: "star-1", sceneKey: "story-position--1", story: { id, state: "WITHDRAWN" } };
  const api = createPublicationApi(async () => Response.json({ items: [slot] }));
  assert.deepEqual(await api.slots(), [slot]);
  for (const items of [[{ ...slot, signingKey: "synthetic-private" }], [slot, slot], [{ ...slot, story: { ...slot.story, role: "admin" } }]]) {
    await assert.rejects(createPublicationApi(async () => Response.json({ items })).slots(), errorIs("retryable"));
  }
});

test("HTTP failure classes are distinct and sensitive server bodies never become UI errors", async () => {
  for (const [status, kind] of [[400, "validation"], [401, "denied"], [403, "denied"], [404, "retryable"], [409, "conflict"], [429, "retryable"], [503, "uncertain"]]) {
    let calls = 0;
    const api = createPublicationApi(async () => { calls++; return Response.json({ secret: "SYNTHETIC_PRIVATE_DIAGNOSTIC" }, { status }); });
    await assert.rejects(api.apply(id, "publish", 2), error => errorIs(kind)(error) && error.status === status
      && !error.message.includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"));
    assert.equal(calls, 1);
  }
  await assert.rejects(createPublicationApi(async () => new Response(null, { status: 503 })).slots(), errorIs("retryable"));
});

test("lost or malformed successful responses stay uncertain and are never retried", async () => {
  for (const response of [null, { story: ack({ id: otherId }) }, { story: { ...ack(), publishedRevisionId: otherId } }, { story: ack({ version: "3" }) }]) {
    let calls = 0;
    const api = createPublicationApi(async () => { calls++; if (!response) throw new Error("synthetic network drop"); return Response.json(response); });
    await assert.rejects(api.apply(id, "publish", 2), errorIs("uncertain")); assert.equal(calls, 1);
  }
});

test("cancelled slot reads use a separate cancelled result", async () => {
  const controller = new globalThis.AbortController(); controller.abort();
  const api = createPublicationApi(async (_path, init) => { assert.equal(init.signal.aborted, true); throw new Error("cancelled"); });
  await assert.rejects(api.slots(controller.signal), errorIs("cancelled"));
});
