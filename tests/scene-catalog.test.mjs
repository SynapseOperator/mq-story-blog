import assert from "node:assert/strict";
import test from "node:test";
import { demoStories } from "../src/data/demo-stories.ts";
import { demoBindings } from "../src/data/demo-bindings.ts";
import { bindSceneStories, storySlotClasses } from "../src/lib/stories/scene-catalog.ts";

// This table records the accepted scene, independently of the implementation.
const acceptedEntries = [
  { id: "demo-starlight", entry: "star", slotId: "star-1", css: "story-position--1" },
  { id: "demo-evening", entry: "star", slotId: "star-2", css: "story-position--2" },
  { id: "demo-everyday", entry: "star", slotId: "star-3", css: "story-position--3" },
  { id: "demo-campfire", entry: "campfire", slotId: null, css: null },
];

function signature(catalog) {
  return catalog.map((story) => ({
    id: story.id,
    entry: story.entry,
    slotId: story.entry === "star" ? story.slotId : null,
    css: story.entry === "star" ? storySlotClasses[story.slotId] : null,
  })).sort((a, b) => a.id.localeCompare(b.id));
}

function acceptedFor(stories) {
  const ids = new Set(stories.map((story) => story.id));
  return acceptedEntries.filter((entry) => ids.has(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function permutations(items) {
  if (items.length === 0) return [[]];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index))
    .map((rest) => [item, ...rest]));
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("all four accepted stories retain their identities, content and entry positions", () => {
  const catalog = bindSceneStories(demoStories, demoBindings);
  assert.equal(catalog.length, 4);
  assert.deepEqual(signature(catalog), acceptedFor(demoStories));
  assert.deepEqual(catalog.map((story) => story.title), [
    "一起数星星", "山坡上的晚风", "把日常写成诗", "我们在一起的故事",
  ]);
  for (const story of catalog) {
    const original = demoStories.find((item) => item.id === story.id);
    assert.ok(original);
    for (const field of ["title", "date", "introduction", "paragraphs", "image", "closing", "source"]) {
      assert.deepEqual(story[field], original[field], `${story.id}: ${field} must survive adaptation`);
    }
    assert.equal(story.source, "synthetic-demo");
  }
});

test("every permutation and filtered subset keeps the accepted bindings (24 × 16 cases)", () => {
  const orders = permutations(demoStories);
  assert.equal(orders.length, 24);
  let cases = 0;
  for (const order of orders) {
    for (let mask = 0; mask < 16; mask += 1) {
      const subset = order.filter((_, index) => mask & (1 << index));
      const result = bindSceneStories(subset, demoBindings);
      assert.deepEqual(signature(result), acceptedFor(subset), `order/subset: ${subset.map((story) => story.id)}`);
      assert.equal(result.length, subset.length, "no missing story may produce a ghost or duplicate entry");
      cases += 1;
    }
  }
  assert.equal(cases, 384);
});

test("binding declaration order does not assign the visual positions", () => {
  for (const bindings of permutations(demoBindings)) {
    assert.deepEqual(signature(bindSceneStories(demoStories, bindings)), acceptedFor(demoStories));
  }
});

test("campfire can be the first source item and still opens only its explicitly bound story", () => {
  const campfire = demoStories.find((story) => story.id === "demo-campfire");
  assert.ok(campfire);
  const stories = [campfire, ...demoStories.filter((story) => story.id !== campfire.id)];
  const fires = bindSceneStories(stories, demoBindings).filter((story) => story.entry === "campfire");
  assert.equal(fires.length, 1);
  assert.equal(fires[0].id, "demo-campfire");
  assert.equal(fires[0].title, "我们在一起的故事");
});

test("a missing campfire never falls back to another story", () => {
  const stars = demoStories.filter((story) => story.id !== "demo-campfire");
  const result = bindSceneStories(stars, demoBindings);
  assert.equal(result.some((story) => story.entry === "campfire"), false);
  assert.deepEqual(signature(result), acceptedFor(stars));
});

test("empty source or no bindings produces no interactive entries", () => {
  assert.deepEqual(bindSceneStories([], demoBindings), []);
  assert.deepEqual(bindSceneStories(demoStories, []), []);
  assert.deepEqual(bindSceneStories([], []), []);
});

test("an unbound story cannot claim a free star or campfire", () => {
  const unbound = { ...demoStories[0], id: "demo-unbound", title: "未绑定的合成演示" };
  const stories = [unbound, ...demoStories.filter((story) => story.id !== "demo-evening")];
  const result = bindSceneStories(stories, demoBindings);
  assert.deepEqual(signature(result), acceptedFor(stories));
  assert.equal(result.some((story) => story.id === unbound.id), false);
  assert.equal(result.some((story) => story.entry === "star" && story.slotId === "star-2"), false);
});

test("inputs remain unchanged, including frozen story content and bindings", () => {
  const stories = deepFreeze(JSON.parse(JSON.stringify(demoStories)));
  const bindings = deepFreeze(JSON.parse(JSON.stringify(demoBindings)));
  const before = JSON.stringify({ stories, bindings });
  assert.deepEqual(signature(bindSceneStories(stories, bindings)), acceptedFor(stories));
  assert.equal(JSON.stringify({ stories, bindings }), before);
});

test("duplicate story identities are rejected instead of silently replacing content", () => {
  const conflictingStory = { ...demoStories[0], title: "不应覆盖的合成标题" };
  assert.throws(() => bindSceneStories([...demoStories, conflictingStory], demoBindings), Error);
});

test("empty or whitespace-only story and binding identities are rejected", () => {
  for (const id of ["", "   "]) {
    assert.throws(() => bindSceneStories([{ ...demoStories[0], id }], []), Error);
    assert.throws(() => bindSceneStories(demoStories, [{ storyId: id, entry: "campfire" }]), Error);
  }
});

test("one story cannot occupy two different entries", () => {
  assert.throws(() => bindSceneStories(demoStories, [
    { entry: "star", slotId: "star-1", storyId: "demo-starlight" },
    { entry: "star", slotId: "star-2", storyId: "demo-starlight" },
  ]), Error);
  assert.throws(() => bindSceneStories(demoStories, [
    { entry: "star", slotId: "star-1", storyId: "demo-starlight" },
    { entry: "campfire", storyId: "demo-starlight" },
  ]), Error);
});

test("two stories cannot occupy the same logical star slot", () => {
  assert.throws(() => bindSceneStories(demoStories, [
    { entry: "star", slotId: "star-1", storyId: "demo-starlight" },
    { entry: "star", slotId: "star-1", storyId: "demo-evening" },
  ]), Error);
});

test("more than one campfire binding is rejected", () => {
  assert.throws(() => bindSceneStories(demoStories, [
    { entry: "campfire", storyId: "demo-campfire" },
    { entry: "campfire", storyId: "demo-evening" },
  ]), Error);
});

test("unknown entry kinds and slots cannot create unpositioned or misidentified entries", () => {
  for (const slotId of ["star-999", "toString", "__proto__"]) {
    assert.throws(() => bindSceneStories(demoStories, [
      { entry: "star", slotId, storyId: "demo-starlight" },
    ]), Error, `reject ${slotId}`);
  }
  assert.throws(() => bindSceneStories(demoStories, [
    { entry: "unknown", storyId: "demo-starlight" },
  ]), Error);
});

test("filtering content does not conceal conflicting or invalid binding definitions", () => {
  assert.throws(() => bindSceneStories([], [
    { entry: "star", slotId: "star-1", storyId: "demo-starlight" },
    { entry: "star", slotId: "star-1", storyId: "demo-evening" },
  ]), Error);
  assert.throws(() => bindSceneStories([], [
    { entry: "star", slotId: "not-a-slot", storyId: "missing-demo" },
  ]), Error);
});
