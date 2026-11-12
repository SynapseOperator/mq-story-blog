import assert from "node:assert/strict";
import test from "node:test";
import { decodePublicCatalog, decodePublicStory } from "../src/lib/stories/public-client.ts";

const star = { id: "00000000-0000-4000-8000-000000000001", slug: "synthetic-one", title: "合成故事一", entry: "star", slotId: "star-1" };
const other = { id: "00000000-0000-4000-8000-000000000002", slug: "synthetic-two", title: "合成故事二", entry: "star", slotId: "star-2" };
const fire = { id: "00000000-0000-4000-8000-000000000003", slug: "synthetic-fire", title: "合成篝火", entry: "campfire" };

test("public catalog reorder/removal preserves explicit slots and campfire identity", () => {
  for (const stories of [[star, other, fire], [fire, other, star], [other, fire], [star], []]) {
    assert.deepEqual(decodePublicCatalog({ stories }), stories);
  }
});

test("all seven slots decode without changing bindings when the catalog is reordered", () => {
  const stars = Array.from({ length: 7 }, (_, index) => ({ ...star,
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    slug: `synthetic-star-${index + 1}`, slotId: `star-${index + 1}` }));
  assert.deepEqual(decodePublicCatalog({ stories: stars.toReversed() }), stars.toReversed());
  assert.throws(() => decodePublicCatalog({ stories: [...stars, { ...other,
    id: "00000000-0000-4000-8000-000000000008", slug: "synthetic-duplicate-slot", slotId: "star-7" }] }));
  assert.throws(() => decodePublicCatalog({ stories: [{ ...star, slotId: "star-8" }] }));
});

test("ambiguous or unknown catalog identities never become interactive entries", () => {
  for (const stories of [[star, star], [star, { ...other, slotId: star.slotId }],
    [fire, { ...fire, id: other.id }], [{ ...star, slotId: "unknown" }], [{ ...star, id: "not-an-id" }]]) {
    assert.throws(() => decodePublicCatalog({ stories }));
  }
  assert.throws(() => decodePublicCatalog({ error: "unavailable" }));
});

test("public contract strips metadata and rejects a different selected story", () => {
  assert.deepEqual(decodePublicCatalog({ stories: [{ ...star, latestRevisionId: "private", content: "private" }] }), [star]);
  const content = { version: 1, blocks: [{ type: "paragraph", text: "合成正文 <script>literal text</script>" }] };
  const story = { id: star.id, slug: star.slug, title: star.title, content };
  assert.deepEqual(decodePublicStory({ story: { ...story, publishedRevisionId: "internal" } }, star.id), story);
  assert.throws(() => decodePublicStory({ story }, other.id));
});

test("public content decoder preserves block order and rejects unsafe image/HTML payloads", () => {
  const content = { version: 1, blocks: [{ type: "paragraph", text: "开头", style: "emphasis" },
    { type: "image", src: "/story-media/synthetic.webp", alt: "合成配图" }, { type: "paragraph", text: "结尾" }] };
  const story = { id: star.id, slug: star.slug, title: star.title, content };
  assert.deepEqual(decodePublicStory({ story }, star.id).content, content);
  for (const blocks of [[{ type: "html", html: "<script>1</script>" }],
    [{ type: "image", src: "javascript:alert(1)", alt: "非法图片" }]]) {
    assert.throws(() => decodePublicStory({ story: { ...story, content: { version: 1, blocks } } }, star.id));
  }
});
