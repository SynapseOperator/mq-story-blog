import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { createStoryHistory, HISTORY_KEY, pathStorySlug, storyPath } from "../src/lib/stories/story-history.ts";

const { structuredClone } = globalThis;

// A deterministic History API host, not a browser simulator. Traversals emit
// popstate asynchronously through flush(); push/replace never emit it. Actual
// Next integration and browser restoration are covered by the E2E suite.
function historyHost(initial = [{ path: "/", state: null }]) {
  const entries = initial.map(value => structuredClone(value));
  const listeners = new Set();
  const traversals = [];
  const calls = [];
  let cursor = entries.length - 1;
  const host = {
    location: { get pathname() { return new URL(entries[cursor].path, "https://mq.invalid").pathname; } },
    history: {
      get state() { return structuredClone(entries[cursor].state); },
      get length() { return entries.length; },
      pushState(state, unused, path) {
        calls.push({ method: "push", state: structuredClone(state), path });
        entries.splice(cursor + 1, entries.length, { path, state: structuredClone(state) });
        cursor++;
      },
      replaceState(state, unused, path) {
        calls.push({ method: "replace", state: structuredClone(state), path });
        entries[cursor] = { path: path ?? entries[cursor].path, state: structuredClone(state) };
      },
      go(delta) { calls.push({ method: "go", delta }); traversals.push(cursor + delta); },
      back() { this.go(-1); },
      forward() { this.go(1); },
    },
    addEventListener(type, listener) { assert.equal(type, "popstate"); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "popstate"); listeners.delete(listener); },
  };
  return { host, calls, entries,
    get cursor() { return cursor; },
    get listeners() { return listeners.size; },
    flush() {
      let count = 0;
      while (traversals.length) {
        assert.ok(++count < 20, "History controller must not loop while restoring a guarded traversal");
        const target = traversals.shift();
        if (target < 0 || target >= entries.length || target === cursor) continue;
        cursor = target;
        for (const listener of [...listeners]) listener();
      }
    },
  };
}

function session(initial, { canClose = true } = {}) {
  const history = historyHost(initial);
  const routes = [];
  const state = { hasReader: false, slug: null, closeRequests: 0, canClose };
  const controller = createStoryHistory(history.host, {
    onRoute(slug, initial = false) { state.slug = slug; state.hasReader = slug !== null; routes.push({ slug, initial }); },
    hasReader() { return state.hasReader; },
    requestClose() { state.closeRequests++; return state.canClose; },
  }, "unit-test-chain");
  return { host: history.host, calls: history.calls, history, controller, state, routes,
    finishClose() { state.hasReader = false; controller.closed(); history.flush(); },
  };
}

test("home open/back/forward reuses the same two entries without duplicate history", () => {
  const s = session();
  assert.deepEqual(s.routes, [{ slug: null, initial: true }]);
  s.controller.open("synthetic-one");
  assert.equal(s.host.location.pathname, "/stories/synthetic-one");
  assert.equal(s.host.history.length, 2);
  s.finishClose();
  assert.equal(s.host.location.pathname, "/");
  s.host.history.forward(); s.history.flush();
  assert.equal(s.state.slug, "synthetic-one");
  s.host.history.back(); s.history.flush();
  assert.equal(s.host.location.pathname, "/stories/synthetic-one", "guard first restores the source URL");
  assert.equal(s.state.closeRequests, 1);
  s.finishClose();
  assert.equal(s.state.slug, null);
  assert.equal(s.host.history.length, 2);
  assert.equal(s.calls.filter(call => call.method === "push").length, 1);
});

test("direct-link close replaces its entry and never navigates to an external predecessor", () => {
  const s = session([{ path: "https://external.invalid/article", state: null }, { path: "/stories/direct-story", state: null }]);
  assert.equal(s.state.slug, "direct-story");
  s.finishClose();
  assert.equal(s.host.location.pathname, "/");
  assert.equal(s.history.cursor, 1);
  assert.equal(s.host.history.length, 2);
  assert.equal(s.calls.filter(call => call.method === "go" || call.method === "push").length, 0);
  assert.equal(s.history.entries[0].path, "https://external.invalid/article");
});

test("cancelled back retains original entry, length, reader and route publication", () => {
  const s = session();
  s.controller.open("synthetic-one");
  const before = structuredClone(s.history.entries);
  const published = s.routes.length;
  s.host.history.back(); s.history.flush();
  assert.equal(s.state.closeRequests, 1);
  s.controller.cancel();
  assert.equal(s.state.slug, "synthetic-one");
  assert.equal(s.history.cursor, 1);
  assert.deepEqual(s.history.entries, before);
  assert.equal(s.routes.length, published);
  assert.equal(s.calls.filter(call => call.method === "push").length, 1);
});

test("approved backward and forward traversals reach the selected owned entry", () => {
  const owned = (index, path) => ({ path, state: { [HISTORY_KEY]: { chain: "saved-chain", index, path, fromHome: false } } });
  const s = session([owned(0, "/stories/first"), owned(1, "/stories/second")]);
  s.host.history.back(); s.history.flush();
  assert.equal(s.state.slug, "second");
  s.finishClose();
  assert.equal(s.state.slug, "first");
  assert.equal(s.history.cursor, 0);
  s.host.history.forward(); s.history.flush();
  assert.equal(s.state.slug, "first");
  s.finishClose();
  assert.equal(s.state.slug, "second");
  assert.equal(s.history.cursor, 1);
  assert.equal(s.state.closeRequests, 2);
  assert.equal(s.host.history.length, 2);
  assert.equal(s.calls.filter(call => call.method === "push").length, 0);
});

test("busy or nested account dialog refuses traversal without changing reader identity", () => {
  const s = session(undefined, { canClose: false });
  s.controller.open("synthetic-one");
  s.host.history.back(); s.history.flush();
  assert.equal(s.state.slug, "synthetic-one");
  assert.equal(s.host.location.pathname, "/stories/synthetic-one");
  assert.equal(s.host.history.length, 2);
  s.state.canClose = true;
  s.host.history.back(); s.history.flush();
  s.finishClose();
  assert.equal(s.state.slug, null);
  assert.equal(s.state.closeRequests, 2);
});

test("repeated opens and further traversals during confirmation cannot stack readers or entries", () => {
  const s = session();
  s.controller.open("synthetic-one");
  s.controller.open("synthetic-one");
  s.controller.open("synthetic-two");
  s.host.history.back(); s.history.flush();
  s.controller.open("synthetic-two");
  s.host.history.back(); s.history.flush();
  assert.equal(s.state.closeRequests, 1);
  assert.equal(s.state.slug, "synthetic-one");
  assert.equal(s.host.history.length, 2);
  assert.equal(s.history.cursor, 1);
  s.controller.cancel();
  s.finishClose();
  assert.equal(s.state.slug, null);
});

test("history state contains only routing coordinates and disposal removes its pop listener", () => {
  const s = session();
  s.controller.open("synthetic-one");
  for (const call of s.calls.filter(call => call.state)) {
    assert.deepEqual(Object.keys(call.state), [HISTORY_KEY]);
    assert.deepEqual(Object.keys(call.state[HISTORY_KEY]).sort(), ["chain", "fromHome", "index", "path"]);
  }
  assert.equal(s.history.listeners, 1);
  const published = s.routes.length;
  s.host.history.back();
  s.controller.dispose();
  s.history.flush();
  assert.equal(s.history.listeners, 0);
  assert.equal(s.routes.length, published);
});

test("unowned predecessor is not hijacked and slug parsing keeps validation outside history", () => {
  const s = session([{ path: "/unowned", state: null }, { path: "/stories/direct-story", state: null }]);
  const published = s.routes.length;
  s.host.history.back(); s.history.flush();
  assert.equal(s.host.location.pathname, "/unowned");
  assert.equal(s.routes.length, published);
  assert.equal(s.state.closeRequests, 0);
  assert.equal(storyPath("simple-slug"), "/stories/simple-slug");
  assert.equal(pathStorySlug("/stories/simple-slug/"), "simple-slug");
  assert.equal(pathStorySlug("/stories/a%2Fb"), "a/b");
  assert.equal(pathStorySlug("/stories/%E0%A4%A"), "%E0%A4%A");
  assert.equal(pathStorySlug("/"), null);
  assert.equal(pathStorySlug("/stories/a/b"), null);
});
