import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPublicStoryReader } from "../../src/server/stories/public-service.ts";
import { createStoryService } from "../../src/server/stories/service.ts";

const { fetch, AbortSignal } = globalThis;

/** Extends P2-06 in the same disposable database. This suite never creates a
 * second source of fixtures and restores published examples before browser QA. */
export async function runSharingReadChecks({ client, readClient, baseURL, fixtureController, setDatabaseAvailable }) {
  const { fixtures, withdrawStory, restoreStory } = fixtureController;
  const reader = createPublicStoryReader(readClient);
  const service = createStoryService(client);
  const apiPath = slug => `/api/stories/by-slug/${encodeURIComponent(slug)}`;
  const pagePath = slug => `/stories/${encodeURIComponent(slug)}`;
  const privateFields = /"(?:draftRevisionId|publishedRevisionId|revisions|password|token|email|emailVerified|createdAt|updatedAt)"\s*:/;
  const extraPublicMarkers = [];
  let passed = 0;
  async function check(name, action) {
    try { await action(); }
    catch (error) { error.publicStage = name; throw error; }
    passed += 1;
    console.log(`PASS story sharing: ${name}`);
  }
  function safe(text, noBody = false) {
    for (const marker of fixtures.privateCanaries) assert.ok(!text.includes(marker));
    if (noBody) for (const marker of [...fixtures.publicCanaries, ...extraPublicMarkers]) assert.ok(!text.includes(marker));
    assert.ok(!privateFields.test(text));
    assert.ok(!text.includes("@accounts.invalid"));
  }
  async function request(path, { noBody = false, ...options } = {}) {
    const response = await fetch(`${baseURL}${path}`, { signal: AbortSignal.timeout(10_000), ...options });
    const text = await response.text();
    safe(text, noBody);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("set-cookie"), null);
    return { status: response.status, text, headers: response.headers };
  }
  async function api(slug, options) {
    const result = await request(apiPath(slug), options);
    return { ...result, data: result.text ? JSON.parse(result.text) : null };
  }
  async function documents(slug, { title, absentTitle } = {}) {
    // Exercise the blocking-metadata bot path as well as ordinary streamed HTML
    // and RSC. None may serialize an unpublished revision or a complete body.
    for (const headers of [{}, { RSC: "1" }, { "user-agent": "Twitterbot/1.0" }]) {
      const response = await request(pagePath(slug), { headers, noBody: true });
      assert.equal(response.status, 200);
      if (headers.RSC) assert.match(response.headers.get("content-type") ?? "", /text\/x-component/);
      else {
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        assert.ok(response.text.includes("noindex"));
        if (title) assert.ok(response.text.includes(`<title>${title} · MQ · Our Stories</title>`));
        else assert.ok(response.text.includes("<title>故事暂不可用 · MQ · Our Stories</title>"));
      }
      if (absentTitle) assert.ok(!response.text.includes(absentTitle));
    }
  }

  await check("slug readers resolve only the current owned published revision and summary whitelist", async () => {
    for (const fixture of [fixtures.starOne, fixtures.starTwo, fixtures.campfire]) {
      assert.deepEqual(await reader.getStoryBySlug(fixture.slug), fixture);
      const summary = await reader.getSummaryBySlug(fixture.slug);
      assert.equal(summary.id, fixture.id);
      assert.equal(summary.title, fixture.title);
      assert.equal(summary.slug, fixture.slug);
      assert.deepEqual(Object.keys(summary).sort(), (summary.entry === "star"
        ? ["entry", "id", "slug", "slotId", "title"] : ["entry", "id", "slug", "title"]).sort());
      safe(JSON.stringify(summary), true);
    }
  });
  await check("anonymous slug API returns exact public DTOs without revision or account fields", async () => {
    for (const fixture of [fixtures.starOne, fixtures.starTwo, fixtures.campfire]) {
      const response = await api(fixture.slug, { headers: { "x-role": "admin", authorization: "Bearer synthetic-forged-role" } });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.text), { story: fixture });
    }
  });
  await check("direct share HTML, RSC and bot metadata expose public titles but no complete article bodies", async () => {
    for (const fixture of [fixtures.starOne, fixtures.starTwo, fixtures.campfire]) {
      await documents(fixture.slug, { title: fixture.title });
    }
  });
  await check("draft, withdrawn and missing slugs stay unavailable across readers, API, HTML, RSC and metadata", async () => {
    for (const slug of [fixtures.draft.slug, fixtures.withdrawn.slug, `missing-${randomUUID()}`]) {
      assert.equal(await reader.getStoryBySlug(slug), null);
      assert.equal(await reader.getSummaryBySlug(slug), null);
      const response = await api(slug);
      assert.equal(response.status, 404);
      assert.deepEqual(response.data, { code: "PUBLIC_STORY_NOT_FOUND" });
      await documents(slug);
    }
  });
  await check("invalid slug input and query injection cannot select nonpublic revisions", async () => {
    for (const slug of ["UPPERCASE", "bad_slug", "bad--slug", "-leading", "trailing-", "a".repeat(121), "' OR 1=1--", "nested/path"]) {
      assert.equal(await reader.getStoryBySlug(slug), null);
      assert.equal(await reader.getSummaryBySlug(slug), null);
      const response = await api(slug);
      assert.equal(response.status, 404);
      assert.deepEqual(response.data, { code: "PUBLIC_STORY_NOT_FOUND" });
    }
    await documents("bad_slug");
    for (const query of ["?state=DRAFT", "?include=draftRevision", "?revision=latest"]) {
      const response = await request(`${apiPath(fixtures.starOne.slug)}${query}`);
      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(response.text), { code: "PUBLIC_STORY_REQUEST_REJECTED" });
      const html = await request(`${pagePath(fixtures.starOne.slug)}${query}`, { noBody: true });
      assert.equal(html.status, 200);
      assert.ok(html.text.includes(`<title>${fixtures.starOne.title} · MQ · Our Stories</title>`));
    }
  });
  await check("slug route has only read methods and HEAD omits the full article body", async () => {
    const before = await client.story.count();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await api(fixtures.starOne.slug, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
      assert.deepEqual(response.data, { code: "METHOD_NOT_ALLOWED" });
    }
    const response = await api(fixtures.starOne.slug, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(response.text, "");
    assert.equal(await client.story.count(), before);
  });
  await check("unpublished title/body edits do not alter shared metadata or public content", async () => {
    const response = await api(fixtures.starOne.slug);
    assert.deepEqual(response.data.story, fixtures.starOne);
    await documents(fixtures.starOne.slug, { title: fixtures.starOne.title });
    const record = await client.story.findUniqueOrThrow({ where: { id: fixtures.starOne.id } });
    assert.notEqual(record.draftRevisionId, record.publishedRevisionId);
  });
  await check("title publication updates metadata and content without changing the stable slug or redeploying", async () => {
    const fixture = fixtures.starTwo;
    const title = "合成演示 · 同一分享地址的新标题";
    const marker = `PUBLIC_SHARE_UPDATED_${randomUUID()}`;
    extraPublicMarkers.push(marker);
    const content = { version: 1, blocks: [{ type: "paragraph", text: marker }] };
    let current = await client.story.findUniqueOrThrow({ where: { id: fixture.id } });
    try {
      current = await service.saveDraft({ storyId: current.id, expectedVersion: current.version, title, content });
      assert.equal(current.slug, fixture.slug);
      assert.deepEqual((await api(fixture.slug)).data.story, fixture);
      await documents(fixture.slug, { title: fixture.title, absentTitle: title });
      current = await service.publish({ storyId: current.id, expectedVersion: current.version });
      assert.equal(current.slug, fixture.slug);
      const updated = await api(fixture.slug, { headers: { "if-none-match": '"old-public-share"' } });
      assert.equal(updated.status, 200);
      assert.deepEqual(updated.data.story, { ...fixture, title, content });
      await documents(fixture.slug, { title, absentTitle: fixture.title });
      // PostgreSQL itself rejects a renamed identity, independently of the read API.
      await assert.rejects(client.story.update({ where: { id: fixture.id }, data: { slug: `changed-${randomUUID()}` } }));
      assert.equal((await client.story.findUniqueOrThrow({ where: { id: fixture.id } })).slug, fixture.slug);
    } finally {
      current = await client.story.findUniqueOrThrow({ where: { id: fixture.id } });
      current = await service.saveDraft({ storyId: current.id, expectedVersion: current.version, title: fixture.title, content: fixture.content });
      await service.publish({ storyId: current.id, expectedVersion: current.version });
    }
    assert.deepEqual((await api(fixture.slug)).data.story, fixture);
  });
  await check("withdrawal invalidates fresh share requests including previously public title metadata", async () => {
    const fixture = fixtures.starOne;
    await documents(fixture.slug, { title: fixture.title });
    await withdrawStory(fixture.id);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await api(fixture.slug, { headers: { "if-none-match": '"previous-share-body"' } });
        assert.equal(response.status, 404);
        assert.deepEqual(response.data, { code: "PUBLIC_STORY_NOT_FOUND" });
        await documents(fixture.slug, { absentTitle: fixture.title });
      }
      assert.equal(await reader.getStoryBySlug(fixture.slug), null);
      assert.equal(await reader.getSummaryBySlug(fixture.slug), null);
    } finally { await restoreStory(fixture.id); }
    assert.deepEqual((await api(fixture.slug)).data.story, fixture);
    await documents(fixture.slug, { title: fixture.title });
  });
  await check("actual database permission failure keeps share metadata generic and API redacted until retry", async () => {
    const fixture = fixtures.starTwo;
    await setDatabaseAvailable(false);
    try {
      await assert.rejects(reader.getStoryBySlug(fixture.slug));
      await assert.rejects(reader.getSummaryBySlug(fixture.slug));
      const response = await api(fixture.slug);
      assert.equal(response.status, 503);
      assert.deepEqual(response.data, { code: "PUBLIC_STORIES_UNAVAILABLE" });
      await documents(fixture.slug, { absentTitle: fixture.title });
    } finally { await setDatabaseAvailable(true); }
    assert.deepEqual((await api(fixture.slug)).data.story, fixture);
    await documents(fixture.slug, { title: fixture.title });
  });
  return { passed, total: 10 };
}
