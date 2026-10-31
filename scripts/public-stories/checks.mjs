import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPublicStoryReader } from "../../src/server/stories/public-service.ts";
import { createStoryService } from "../../src/server/stories/service.ts";

const { fetch, AbortSignal } = globalThis;
const summaryKeys = item => (item.entry === "star"
  ? ["entry", "id", "slug", "slotId", "title"] : ["entry", "id", "slug", "title"]).sort();

export async function runPublicReadChecks({ client, readClient, readPool, baseURL, fixtureController,
  setDatabaseAvailable, runtimeRole }) {
  const { fixtures, withdrawStory, restoreStory, setPublicVisible } = fixtureController;
  const reader = createPublicStoryReader(readClient);
  const service = createStoryService(client);
  let passed = 0;
  async function check(name, action) {
    try { await action(); }
    catch (error) { error.publicStage = name; throw error; }
    passed += 1;
    console.log(`PASS public stories: ${name}`);
  }
  function safe(text, { noBody = false } = {}) {
    for (const marker of fixtures.privateCanaries) assert.ok(!text.includes(marker));
    if (noBody) for (const marker of fixtures.publicCanaries) assert.ok(!text.includes(marker));
    assert.ok(!/"(?:draftRevisionId|publishedRevisionId|revisions|password|token|email|emailVerified|version|createdAt|updatedAt)"\s*:/.test(
      noBody ? text : text.replace(/"version":1/g, "")));
    assert.ok(!text.includes("@accounts.invalid"));
  }
  async function request(path, options = {}) {
    const response = await fetch(`${baseURL}${path}`, { signal: AbortSignal.timeout(10_000), ...options });
    const text = await response.text();
    safe(text);
    if (path.startsWith("/api/stories")) {
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(response.headers.get("set-cookie"), null);
    }
    return { status: response.status, text, data: text ? JSON.parse(text) : null, headers: response.headers };
  }
  const path = id => `/api/stories/${id}`;
  const catalog = async () => (await request("/api/stories")).data.stories;
  function identities(items) { return items.map(item => ({ id: item.id, entry: item.entry, slotId: item.slotId })).sort((a, b) => a.id.localeCompare(b.id)); }
  const publicIds = [fixtures.starOne.id, fixtures.starTwo.id, fixtures.campfire.id];

  await check("HTTP worker uses an actual nonprivileged read-only database identity", async () => {
    const row = (await readPool.query(`SELECT current_user AS role,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS privileged,
      has_table_privilege(current_user, 'public.story', 'INSERT,UPDATE,DELETE,TRUNCATE') AS write,
      has_table_privilege(current_user, 'public."User"', 'SELECT') AS users,
      has_schema_privilege(current_user, 'public', 'CREATE') AS ddl`)).rows[0];
    assert.equal(row.role, runtimeRole);
    assert.equal(row.privileged, false);
    assert.equal(row.write, false);
    assert.equal(row.users, false);
    assert.equal(row.ddl, false);
    await assert.rejects(readPool.query("INSERT INTO public.story DEFAULT VALUES"), error => error.code === "42501");
  });
  await check("native PostgreSQL reader exposes only published summary DTOs without article bodies", async () => {
    const summaries = await reader.listStories();
    assert.deepEqual(summaries.map(item => item.id).sort(), [...publicIds].sort());
    for (const item of summaries) assert.deepEqual(Object.keys(item).sort(), summaryKeys(item));
    assert.equal(summaries.find(item => item.id === fixtures.starOne.id).slotId, "star-1");
    assert.equal(summaries.find(item => item.id === fixtures.starTwo.id).slotId, "star-2");
    safe(JSON.stringify(summaries), { noBody: true });
  });
  await check("public detail reads exact immutable published blocks and omits internal revision metadata", async () => {
    for (const fixture of [fixtures.starOne, fixtures.starTwo, fixtures.campfire]) {
      const result = await reader.getStory(fixture.id);
      assert.deepEqual(result, fixture);
      assert.deepEqual(Object.keys(result).sort(), ["content", "id", "slug", "title"]);
      safe(JSON.stringify(result));
    }
  });
  await check("draft, withdrawn, nonexistent and revision identities are not publicly addressable", async () => {
    const current = await client.story.findUniqueOrThrow({ where: { id: fixtures.starOne.id } });
    for (const id of [fixtures.draft.id, fixtures.withdrawn.id, randomUUID(), current.draftRevisionId, current.publishedRevisionId]) {
      assert.equal(await reader.getStory(id), null);
      const response = await request(path(id));
      assert.equal(response.status, 404);
      assert.deepEqual(response.data, { code: "PUBLIC_STORY_NOT_FOUND" });
    }
  });
  await check("anonymous HTTP catalog and lazy detail preserve exact public whitelist", async () => {
    const response = await request("/api/stories");
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.data), ["stories"]);
    safe(response.text, { noBody: true });
    for (const item of response.data.stories) assert.deepEqual(Object.keys(item).sort(), summaryKeys(item));
    for (const fixture of [fixtures.starOne, fixtures.starTwo, fixtures.campfire]) {
      const detail = await request(path(fixture.id), { headers: { authorization: "Bearer forged-role-admin", "x-role": "admin" } });
      assert.equal(detail.status, 200);
      assert.deepEqual(detail.data, { story: fixture });
    }
  });
  await check("long, multi-image, missing-image and image-free content remain ordered structured blocks", async () => {
    const long = (await request(path(fixtures.starOne.id))).data.story.content.blocks;
    assert.ok(long.filter(block => block.type === "paragraph").length >= 25);
    assert.equal(long.filter(block => block.type === "image").length, 3);
    const pictures = long.filter(block => block.type === "image");
    for (const image of pictures.slice(0, 2)) {
      const asset = await fetch(`${baseURL}${image.src}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get("content-type") ?? "", /^image\//);
    }
    assert.equal((await fetch(`${baseURL}${pictures[2].src}`)).status, 404);
    const short = (await request(path(fixtures.starTwo.id))).data.story.content.blocks;
    assert.ok(short.every(block => block.type === "paragraph"));
  });
  await check("homepage HTML and RSC contain neither complete public bodies nor nonpublic content", async () => {
    const html = await fetch(`${baseURL}/`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(html.status, 200);
    const body = await html.text();
    safe(body, { noBody: true });
    assert.match(body, /MQ/);
    const rsc = await fetch(`${baseURL}/`, { headers: { RSC: "1" }, signal: AbortSignal.timeout(10_000) });
    assert.equal(rsc.status, 200);
    assert.match(rsc.headers.get("content-type") ?? "", /text\/x-component/);
    safe(await rsc.text(), { noBody: true });
  });
  await check("query parameters and malformed IDs cannot select drafts or alter public queries", async () => {
    for (const suffix of ["?state=DRAFT", "?include=draftRevision", "?revision=latest"]) {
      for (const endpoint of ["/api/stories", path(fixtures.starOne.id)]) {
        const response = await request(`${endpoint}${suffix}`);
        assert.equal(response.status, 400);
        assert.deepEqual(response.data, { code: "PUBLIC_STORY_REQUEST_REJECTED" });
      }
    }
    for (const id of ["not-an-id", "draft", "null", "00000000-0000-0000-0000-00000000000x", "%27OR%201%3D1--"]) {
      const response = await request(path(id));
      assert.equal(response.status, 404);
      assert.deepEqual(response.data, { code: "PUBLIC_STORY_NOT_FOUND" });
    }
  });
  await check("public HTTP routes have no mutation interface and HEAD has no article body", async () => {
    const before = await client.story.count();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      for (const endpoint of ["/api/stories", path(fixtures.starOne.id)]) {
        const response = await request(endpoint, { method });
        assert.equal(response.status, 405);
        assert.equal(response.headers.get("allow"), "GET, HEAD");
      }
    }
    assert.equal(await client.story.count(), before);
    const head = await request(path(fixtures.starOne.id), { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
  });
  await check("saving an unpublished draft never changes the public title or body", async () => {
    const before = await request(path(fixtures.starOne.id));
    assert.deepEqual(before.data.story, fixtures.starOne);
    const state = await client.story.findUniqueOrThrow({ where: { id: fixtures.starOne.id } });
    assert.notEqual(state.draftRevisionId, state.publishedRevisionId);
    const privateTitle = (await client.storyRevision.findUniqueOrThrow({ where: { id: state.draftRevisionId } })).title;
    assert.ok(fixtures.privateCanaries.includes(privateTitle));
    assert.ok(!(await catalog()).some(item => item.title === privateTitle));
  });
  await check("explicit publish update becomes visible to a fresh request without deployment or stale 304", async () => {
    let state = await client.story.findUniqueOrThrow({ where: { id: fixtures.starTwo.id } });
    const changedTitle = "合成演示 · 已显式发布的短笺更新";
    const changedContent = { version: 1, blocks: [{ type: "paragraph", text: `PUBLIC_UPDATED_${randomUUID()}` }] };
    state = await service.saveDraft({ storyId: state.id, expectedVersion: state.version, title: changedTitle, content: changedContent });
    assert.deepEqual((await request(path(state.id))).data.story, fixtures.starTwo);
    state = await service.publish({ storyId: state.id, expectedVersion: state.version });
    const updated = await request(path(state.id), { headers: { "if-none-match": '"stale-client-copy"' } });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.story.title, changedTitle);
    assert.deepEqual(updated.data.story.content, changedContent);
    assert.equal((await catalog()).find(item => item.id === state.id).title, changedTitle);
    state = await service.saveDraft({ storyId: state.id, expectedVersion: state.version,
      title: fixtures.starTwo.title, content: fixtures.starTwo.content });
    await service.publish({ storyId: state.id, expectedVersion: state.version });
  });
  await check("withdrawal immediately removes new public reads without moving any remaining slot", async () => {
    const baseline = identities(await catalog());
    await withdrawStory(fixtures.starOne.id);
    try {
      const current = await catalog();
      assert.deepEqual(identities(current), baseline.filter(item => item.id !== fixtures.starOne.id));
      for (let i = 0; i < 3; i += 1) {
        const response = await request(path(fixtures.starOne.id), { headers: { "if-none-match": '"previous-public-response"' } });
        assert.equal(response.status, 404);
      }
      assert.equal(await reader.getStory(fixtures.starOne.id), null);
    } finally { await restoreStory(fixtures.starOne.id); }
    assert.deepEqual(identities(await catalog()), baseline);
    assert.deepEqual((await request(path(fixtures.starOne.id))).data.story, fixtures.starOne);
  });
  await check("an empty public catalog is successful empty data, never synthetic fallback", async () => {
    await setPublicVisible(false);
    try {
      const response = await request("/api/stories");
      assert.equal(response.status, 200);
      assert.deepEqual(response.data, { stories: [] });
      assert.deepEqual(await reader.listStories(), []);
      for (const id of publicIds) assert.equal((await request(path(id))).status, 404);
    } finally { await setPublicVisible(true); }
  });
  await check("actual PostgreSQL permission failure yields redacted 503 and retries recover", async () => {
    await setDatabaseAvailable(false);
    try {
      await assert.rejects(reader.listStories());
      for (const endpoint of ["/api/stories", path(fixtures.starTwo.id)]) {
        const response = await request(endpoint);
        assert.equal(response.status, 503);
        assert.deepEqual(response.data, { code: "PUBLIC_STORIES_UNAVAILABLE" });
        assert.ok(!/postgres|prisma|SELECT|permission denied|password|database/i.test(response.text));
      }
    } finally { await setDatabaseAvailable(true); }
    assert.equal((await request("/api/stories")).status, 200);
    assert.equal((await request(path(fixtures.starTwo.id))).status, 200);
  });
  await check("unmapped publication slots fail closed instead of moving or silently omitting a star", async () => {
    const slotId = `unmapped-${randomUUID()}`;
    await client.starSlot.create({ data: { id: slotId, sceneKey: slotId } });
    let unknown = await service.createDraft({ slug: slotId, title: "合成未知星位", kind: "STAR", slotId,
      content: { version: 1, blocks: [{ type: "paragraph", text: "隔离测试" }] } });
    unknown = await service.publish({ storyId: unknown.id, expectedVersion: unknown.version });
    try {
      await assert.rejects(reader.listStories());
      await assert.rejects(reader.getStory(unknown.id));
      assert.equal((await request("/api/stories")).status, 503);
      assert.equal((await request(path(unknown.id))).status, 503);
    } finally { await service.withdraw({ storyId: unknown.id, expectedVersion: unknown.version }); }
    assert.deepEqual((await catalog()).map(item => item.id).sort(), [...publicIds].sort());
  });
  return { passed, total: 15 };
}
