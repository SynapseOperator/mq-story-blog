import { sessionFixture } from "../auth/session-fixture.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin, revokeAdmin, restoreAdmin } from "../../src/server/admin/maintenance.ts";
import { createStoryService } from "../../src/server/stories/service.ts";
import { assertTemporaryTarget, transport, observeWait, content, assertSummary, privateHeaders } from "./test-support.mjs";

export async function runDraftHttpTests({ connectionString, maintenanceUrl, runtimeRole, origin }) {
  const target = assertTemporaryTarget(connectionString);
  const maintenanceTarget = assertTemporaryTarget(maintenanceUrl);
  assert.equal(target.pathname, maintenanceTarget.pathname);
  assert.equal(target.host, maintenanceTarget.host);
  assert.match(runtimeRole, /^mq_admin_rt_[a-f0-9]{32}$/);
  const owner = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  const maintenance = createAuthDatabaseClient(maintenanceUrl);
  const trusted = createAuthDatabaseClient(connectionString);
  const lifecycle = createStoryService(trusted);
  const suffix = randomBytes(5).toString("hex");
  const admin = { username: `admin_${suffix}`, password: `MqAdmin!${randomBytes(24).toString("base64url")}` };
  const regular = { username: `reader_${suffix}`, password: `MqReader!${randomBytes(24).toString("base64url")}` };
  const secrets = new Set([admin.password, regular.password]);
  const privateCanaries = [`PRIVATE_DRAFT_${randomUUID()}`, `UNPUBLISHED_REVISION_${randomUUID()}`];
  const request = transport(origin, secrets);
  let adminJar = {};
  const regularJar = {};
  let grant;
  let draft;
  let passed = 0;
  let stage = "setup";
  const path = id => `/api/admin/stories/${id}/draft`;
  const input = title => ({ kind: "STAR", title, content: content(title) });
  const save = (story, title, jar = adminJar) => request(path(story.id), {
    method: "PUT", jar, body: { expectedVersion: story.version, title, content: content(title) },
  });
  async function collectSecrets() {
    const rows = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT "tokenCiphertext" AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
    rows.forEach(row => secrets.add(row.value));
  }
  async function run(name, test) {
    stage = name;
    // Only this invocation's confirmed temporary database is touched.
    await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
    await test();
    await collectSecrets();
    passed++;
    console.log(`PASS draft HTTP: ${name}`);
  }
  async function login() {
    const jar = {};
    assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: admin, jar })).status, 200);
    assert.ok(jar.cookie);
    await collectSecrets();
    return jar;
  }
  async function snapshot(id) {
    return (await owner.query('SELECT s.*, (SELECT count(*)::int FROM story_revision r WHERE r.story_id=s.id) AS revisions FROM story s WHERE s.id=$1', [id])).rows[0];
  }
  async function revisionGate(operation) {
    const key = randomBytes(4).readUInt32BE() % 2_000_000_000;
    const gate = await owner.connect();
    try {
      await owner.query(`CREATE FUNCTION public.mq_test_draft_http_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(${key}); RETURN NEW; END; $$`);
      await owner.query('CREATE TRIGGER mq_test_draft_http_gate BEFORE INSERT ON story_revision FOR EACH ROW EXECUTE FUNCTION public.mq_test_draft_http_gate()');
      await gate.query("SELECT pg_advisory_lock($1)", [key]);
      let unlocked = false;
      await operation(async () => { if (!unlocked) { unlocked = true; await gate.query("SELECT pg_advisory_unlock($1)", [key]); } });
    } finally {
      await gate.query("SELECT pg_advisory_unlock($1)", [key]);
      await owner.query('DROP TRIGGER IF EXISTS mq_test_draft_http_gate ON story_revision; DROP FUNCTION IF EXISTS public.mq_test_draft_http_gate()');
      gate.release();
    }
  }
  try {
    await run("guest and ordinary identities cannot reach any draft operation", async () => {
      const unknown = randomUUID();
      const operations = [
        ["/api/admin/stories", { method: "POST", body: input("Synthetic denied") }],
        ["/api/admin/stories", {}], [path(unknown), {}],
        [path(unknown), { method: "PUT", body: { expectedVersion: 0, title: "Denied", content: content("Denied") } }],
      ];
      for (const [route, options] of operations) {
        const result = await request(route, options); assert.equal(result.status, 401); privateHeaders(result);
      }
      assert.equal((await request("/api/auth/sign-up/email", { method: "POST", body: regular, jar: regularJar })).status, 200);
      for (const [route, options] of operations) {
        const result = await request(route, { ...options, jar: regularJar, headers: { "x-role": "admin" } });
        assert.equal(result.status, 403); privateHeaders(result);
      }
      assert.equal(Number((await owner.query('SELECT count(*) FROM story')).rows[0].count), 0);
      grant = await initializeAdmin(maintenance, admin);
      adminJar = await login();
    });
    await run("admin creates slot-free draft and receives only the private summary DTO", async () => {
      const created = await request("/api/admin/stories", { method: "POST", body: input(privateCanaries[0]), jar: adminJar });
      assert.equal(created.status, 201); privateHeaders(created);
      assert.deepEqual(Object.keys(created.data), ["story"]);
      draft = created.data.story; assertSummary(draft);
      assert.equal(draft.state, "DRAFT"); assert.equal(draft.version, 0);
      const stored = await snapshot(draft.id);
      assert.equal(stored.slot_id, null); assert.equal(stored.published_revision_id, null); assert.equal(stored.revisions, 1);
      const details = await request(path(draft.id), { jar: adminJar });
      assert.equal(details.status, 200); privateHeaders(details);
      assert.deepEqual(Object.keys(details.data).sort(), ["draft", "story"]);
      assert.deepEqual(details.data.draft, { title: privateCanaries[0], content: content(privateCanaries[0]) });
    });
    await run("stable pagination has no duplicate rows and no content bodies", async () => {
      for (let i = 0; i < 3; i++) assert.equal((await request("/api/admin/stories", { method: "POST", jar: adminJar, body: input(`Synthetic page ${i}`) })).status, 201);
      let cursor = null;
      const ids = new Set();
      do {
        const page = await request(`/api/admin/stories?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { jar: adminJar });
        assert.equal(page.status, 200); privateHeaders(page);
        assert.deepEqual(Object.keys(page.data).sort(), ["items", "nextCursor"]);
        assert.ok(page.data.items.length <= 2);
        for (const item of page.data.items) { assertSummary(item); assert.ok(!ids.has(item.id)); ids.add(item.id); }
        cursor = page.data.nextCursor;
      } while (cursor);
      assert.equal(ids.size, 4);
    });
    await run("save appends an immutable version and preserves slug", async () => {
      const saved = await save(draft, privateCanaries[1]);
      assert.equal(saved.status, 200); privateHeaders(saved); assertSummary(saved.data.story);
      assert.equal(saved.data.story.version, 1); assert.equal(saved.data.story.slug, draft.slug);
      draft = saved.data.story;
      const details = await request(path(draft.id), { jar: adminJar });
      assert.equal(details.data.draft.title, privateCanaries[1]);
      assert.equal((await snapshot(draft.id)).revisions, 2);
    });
    await run("approved synthetic image and structured text round-trip without a second renderer", async () => {
      const structured = { version: 1, blocks: [
        { type: "paragraph", text: "Synthetic paragraph before image", style: "emphasis" },
        { type: "image", src: "/scene/night-sky.webp", alt: "Synthetic night sky", caption: "Synthetic project reference" },
        { type: "paragraph", text: "Synthetic paragraph after image", style: "strong" },
      ] };
      const created = await request("/api/admin/stories", { method: "POST", jar: adminJar,
        body: { kind: "STAR", title: "Synthetic structured content", content: structured } });
      assert.equal(created.status, 201);
      const result = await request(path(created.data.story.id), { jar: adminJar });
      assert.equal(result.status, 200); assert.deepEqual(result.data.draft.content, structured);
    });
    await run("strict request validation rejects unsafe fields, bodies, queries and methods", async () => {
      for (const route of ["/api/admin/stories", path(draft.id)]) {
        for (const [jar, status] of [[undefined, 401], [regularJar, 403], [adminJar, 200]]) {
          const response = await request(route, { method: "HEAD", jar });
          assert.equal(response.status, status); assert.equal(response.text, ""); privateHeaders(response);
        }
      }
      for (const extra of [{ slug: "chosen" }, { slotId: "star-1" }, { state: "PUBLISHED" }, { publishedRevisionId: randomUUID() }, { role: "admin" }]) {
        assert.equal((await request("/api/admin/stories", { method: "POST", jar: adminJar, body: { ...input("Invalid"), ...extra } })).status, 400);
      }
      for (const query of ["limit=51", "limit=0", "limit=2&limit=3", "unknown=x", "cursor=not-json", `cursor=${Buffer.from(JSON.stringify({ createdAt: "invalid", id: randomUUID() })).toString("base64url")}`]) {
        assert.equal((await request(`/api/admin/stories?${query}`, { jar: adminJar })).status, 400);
      }
      for (const createdAt of ["+010000-01-01T00:00:00.000Z", "0999-12-31T23:59:59.000Z"]) {
        const cursor = Buffer.from(JSON.stringify({ createdAt, id: draft.id })).toString("base64url");
        assert.equal((await request(`/api/admin/stories?cursor=${cursor}`, { jar: adminJar })).status, 400);
      }
      assert.equal((await request(`${path(draft.id)}?revision=published`, { jar: adminJar })).status, 400);
      for (const [route, method, body] of [["/api/admin/stories", "POST", input("Rejected override")],
        [path(draft.id), "PUT", { expectedVersion: draft.version, title: "Rejected override", content: content("Rejected override") }]]) {
        const response = await request(route, { method, body, jar: adminJar, headers: { "x-http-method-override": "GET" } });
        assert.equal(response.status, 400);
      }
      const encodedId = `%${draft.id.charCodeAt(0).toString(16)}${draft.id.slice(1)}`;
      for (const route of [path(encodedId), "/api/admin/%73tories"]) {
        const response = await request(route, { jar: adminJar });
        assert.ok([400, 404].includes(response.status));
        for (const canary of privateCanaries) assert.ok(!response.text.includes(canary));
      }
      assert.equal((await request(path("invalid"), { jar: adminJar })).status, 400);
      assert.equal((await request(path(randomUUID()), { jar: adminJar })).status, 404);
      assert.equal((await request("/api/admin/stories", { method: "POST", jar: adminJar, rawBody: "{", headers: { "content-type": "application/json" } })).status, 400);
      assert.equal((await request("/api/admin/stories", { method: "POST", jar: adminJar, rawBody: "text", headers: { "content-type": "text/plain" } })).status, 415);
      assert.equal((await request("/api/admin/stories", { method: "POST", jar: adminJar, body: input("x".repeat(300_000)) })).status, 413);
      for (const [route, method] of [["/api/admin/stories", "PUT"], [path(draft.id), "POST"], [path(draft.id), "DELETE"]]) {
        assert.equal((await request(route, { method, jar: adminJar })).status, 405);
      }
      const before = await snapshot(draft.id);
      for (const invalid of [
        { expectedVersion: draft.version, title: "Invalid", content: { version: 1, blocks: [{ type: "html", html: "<script>bad</script>" }] } },
        { expectedVersion: -1, title: "Invalid", content: content("Invalid") },
        { expectedVersion: draft.version, title: "Invalid", content: { version: 1, blocks: [{ type: "image", src: "https://example.invalid/private.png", alt: "Invalid" }] } },
        { expectedVersion: draft.version, title: "Invalid", content: { version: 1, blocks: [{ type: "image", src: "/story-media/not-an-approved-asset.webp", alt: "Invalid" }] } },
      ]) assert.equal((await request(path(draft.id), { method: "PUT", body: invalid, jar: adminJar })).status, 400);
      assert.deepEqual(await snapshot(draft.id), before);
    });
    await run("origin and forged session protection is enforced on read and write", async () => {
      for (const [route, options] of [["/api/admin/stories", {}], [path(draft.id), {}], [path(draft.id), { method: "PUT", body: { expectedVersion: draft.version, title: "Denied", content: content("Denied") } }]]) {
        assert.equal((await request(route, { ...options, jar: adminJar, requestOrigin: "https://cross-site.example.invalid" })).status, 403);
        assert.equal((await request(route, { ...options, jar: { cookie: "mq.session_token=forged; role=admin" } })).status, 401);
      }
    });
    await run("stale save returns conflict and leaves no orphan revision", async () => {
      const before = await snapshot(draft.id);
      const sent = { expectedVersion: 0, title: "Retain local content", content: content("Retain local content") };
      const result = await request(path(draft.id), { method: "PUT", body: sent, jar: adminJar });
      assert.equal(result.status, 409); privateHeaders(result); assert.equal(result.data.code, "DRAFT_CONFLICT");
      assert.equal(sent.content.blocks[0].text, "Retain local content");
      assert.deepEqual(await snapshot(draft.id), before);
    });
    await run("campfire creation is slot-free and duplicate identity returns a safe conflict", async () => {
      const body = { kind: "CAMPFIRE", title: "Synthetic campfire draft", content: content("Synthetic campfire body") };
      const results = await Promise.all([request("/api/admin/stories", { method: "POST", body, jar: adminJar }), request("/api/admin/stories", { method: "POST", body, jar: adminJar })]);
      if (results.some(result => ![201, 409].includes(result.status))) {
        console.error(`Draft campfire HTTP statuses: ${results.map(result => result.status).join(",")}`);
      }
      assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
      const row = results.find(result => result.status === 201).data.story;
      assert.equal(row.kind, "CAMPFIRE"); assert.equal((await snapshot(row.id)).slot_id, null);
      const stored = (await owner.query("SELECT count(*)::int AS n FROM story WHERE kind='CAMPFIRE'")).rows[0];
      assert.equal(stored.n, 1);
      assert.equal((await snapshot(row.id)).revisions, 1);
    });
    await run("two real concurrent HTTP saves have exactly one CAS winner", async () => {
      const before = await snapshot(draft.id);
      await revisionGate(async unlock => {
        const attempts = [save(draft, "Concurrent A"), save(draft, "Concurrent B")];
        const settled = Promise.allSettled(attempts);
        try { await observeWait(owner, runtimeRole, "wait_event='advisory'", 2); }
        finally { await unlock(); }
        const values = await settled;
        assert.ok(values.every(value => value.status === "fulfilled"));
        const results = values.map(value => value.value);
        assert.deepEqual(results.map(value => value.status).sort(), [200, 409]);
        draft = results.find(value => value.status === 200).data.story;
      });
      const after = await snapshot(draft.id);
      assert.equal(after.version, before.version + 1); assert.equal(after.revisions, before.revisions + 1);
    });
    await run("published and withdrawn draft saves preserve the public pointer and state", async () => {
      let story = await lifecycle.createDraft({ slug: `story-${randomUUID().replaceAll("-", "")}`, kind: "STAR", slotId: "star-1", title: "Synthetic public version", content: content("Synthetic public body") });
      story = await lifecycle.publish({ storyId: story.id, expectedVersion: story.version });
      const publicBefore = await lifecycle.getPublicStory(story.slug);
      let result = await save(story, privateCanaries[1]);
      assert.equal(result.status, 200); assert.equal(result.data.story.state, "PUBLISHED");
      assert.deepEqual(await lifecycle.getPublicStory(story.slug), publicBefore);
      story = await lifecycle.withdraw({ storyId: story.id, expectedVersion: result.data.story.version });
      const before = await snapshot(story.id);
      result = await save(story, "Synthetic withdrawn edit");
      assert.equal(result.status, 200); assert.equal(result.data.story.state, "WITHDRAWN");
      const after = await snapshot(story.id);
      assert.equal(after.published_revision_id, before.published_revision_id); assert.equal(after.slot_id, before.slot_id);
      assert.equal(await lifecycle.getPublicStory(story.slug), null);
    });
    await run("protected draft save preserves anonymous public APIs, share HTML, RSC and metadata until withdrawal", async () => {
      const publicTitle = `Synthetic joint original ${randomUUID()}`;
      const publicBody = `PUBLIC_JOINT_BODY_${randomUUID()}`;
      const privateTitle = `PRIVATE_JOINT_TITLE_${randomUUID()}`;
      const privateBody = `PRIVATE_JOINT_BODY_${randomUUID()}`;
      privateCanaries.push(privateTitle, privateBody);
      // Only the fixture setup publishes, through the internal lifecycle in
      // this runner's disposable database. The actual draft save uses HTTP
      // and the application's restricted runtime identity and withAdmin tx.
      stage = "joint public isolation: fixture publication";
      let story = await lifecycle.createDraft({ slug: `story-${randomUUID().replaceAll("-", "")}`,
        kind: "STAR", slotId: "star-2", title: publicTitle, content: content(publicBody) });
      story = await lifecycle.publish({ storyId: story.id, expectedVersion: story.version });
      const before = await snapshot(story.id);
      const publicDetail = { id: story.id, slug: story.slug, title: publicTitle, content: content(publicBody) };
      async function assertPublicVersion(visible, phase) {
        // No administrator/ordinary Cookie, auth header or Origin is sent to
        // any public surface; a logged-in caller must not mask an isolation bug.
        stage = `joint public isolation ${phase}: catalog request`;
        const catalog = await request("/api/stories", { requestOrigin: null });
        stage = `joint public isolation ${phase}: catalog DTO`;
        assert.equal(catalog.status, 200);
        const summary = catalog.data.stories.find(item => item.id === story.id);
        assert.deepEqual(summary, visible
          ? { id: story.id, slug: story.slug, title: publicTitle, entry: "star", slotId: "star-2" }
          : undefined);
        assert.ok(!catalog.data.stories.some(item => item.id === draft.id));
        const responses = [catalog];
        for (const [surface, route] of [["ID", `/api/stories/${story.id}`], ["slug", `/api/stories/by-slug/${story.slug}`]]) {
          stage = `joint public isolation ${phase}: ${surface} API request`;
          const result = await request(route, { requestOrigin: null });
          stage = `joint public isolation ${phase}: ${surface} API DTO`;
          assert.equal(result.status, visible ? 200 : 404);
          assert.deepEqual(result.data, visible ? { story: publicDetail } : { code: "PUBLIC_STORY_NOT_FOUND" });
          responses.push(result);
        }
        for (const [surface, headers] of [["HTML", {}], ["RSC", { RSC: "1" }], ["metadata", { "user-agent": "Twitterbot/1.0" }]]) {
          stage = `joint public isolation ${phase}: ${surface} request`;
          let page = await request(`/stories/${story.slug}`, { requestOrigin: null, headers });
          // Unlike fetch in the sharing suite, this credential-aware Node
          // transport does not follow redirects. Next normalizes bare RSC
          // requests to a cache-busting query before serving the component.
          if (headers.RSC && page.status === 307) {
            stage = `joint public isolation ${phase}: same-story RSC canonical redirect`;
            const canonical = new URL(page.headers.location, origin);
            assert.equal(canonical.origin, origin);
            assert.equal(canonical.pathname, `/stories/${story.slug}`);
            assert.deepEqual([...canonical.searchParams.keys()], ["_rsc"]);
            assert.equal(canonical.hash, "");
            assert.equal(page.headers["set-cookie"], undefined);
            assert.equal(page.text, "");
            page = await request(`${canonical.pathname}${canonical.search}`, { requestOrigin: null, headers });
          }
          stage = `joint public isolation ${phase}: ${surface} status`;
          assert.equal(page.status, 200); // Unavailable stories retain the MQ shell.
          stage = `joint public isolation ${phase}: ${surface} content type`;
          if (headers.RSC) assert.match(page.headers["content-type"] ?? "", /text\/x-component/);
          else {
            assert.match(page.headers["content-type"] ?? "", /text\/html/);
            stage = `joint public isolation ${phase}: ${surface} title`;
            assert.ok(page.text.includes(visible
              ? `<title>${publicTitle} · MQ · Our Stories</title>`
              : "<title>故事暂不可用 · MQ · Our Stories</title>"));
            stage = `joint public isolation ${phase}: ${surface} robots`;
            assert.ok(page.text.includes("noindex"));
          }
          stage = `joint public isolation ${phase}: ${surface} deferred body`;
          assert.ok(!page.text.includes(publicBody), "Share shell must not preload the full public body");
          responses.push(page);
        }
        for (const [index, response] of responses.entries()) {
          stage = `joint public isolation ${phase}: response ${index} privacy and cache`;
          assert.match(response.headers["cache-control"] ?? "", /no-store/);
          assert.equal(response.headers["set-cookie"], undefined);
          for (const marker of privateCanaries) assert.ok(!response.text.includes(marker));
          assert.ok(!/"(?:draftRevisionId|publishedRevisionId|draftTitle|hasUnpublishedChanges)"\s*:/.test(response.text));
          if (!visible) {
            assert.ok(!response.text.includes(publicTitle));
            assert.ok(!response.text.includes(publicBody));
          }
        }
      }
      await assertPublicVersion(true, "before save");
      stage = "joint public isolation: protected draft save";
      const saved = await request(path(story.id), { method: "PUT", jar: adminJar,
        body: { expectedVersion: story.version, title: privateTitle, content: content(privateBody) } });
      assert.equal(saved.status, 200); privateHeaders(saved); assertSummary(saved.data.story);
      assert.equal(saved.data.story.state, "PUBLISHED");
      assert.equal(saved.data.story.slug, story.slug);
      assert.equal(saved.data.story.hasUnpublishedChanges, true);
      stage = "joint public isolation: private draft readback";
      const details = await request(path(story.id), { jar: adminJar });
      assert.equal(details.status, 200); privateHeaders(details);
      assert.deepEqual(details.data.draft, { title: privateTitle, content: content(privateBody) });
      stage = "joint public isolation: persisted revision pointers";
      const after = await snapshot(story.id);
      assert.equal(after.version, before.version + 1);
      assert.equal(after.revisions, before.revisions + 1);
      assert.equal(after.published_revision_id, before.published_revision_id);
      assert.notEqual(after.draft_revision_id, after.published_revision_id);
      assert.equal(after.slot_id, before.slot_id);
      await assertPublicVersion(true, "after save");
      stage = "joint public isolation: withdrawal";
      await lifecycle.withdraw({ storyId: story.id, expectedVersion: saved.data.story.version });
      await assertPublicVersion(false, "after withdrawal");
    });
    await run("database failure after revision insert returns safe 503 and fully rolls back", async () => {
      const before = await snapshot(draft.id);
      await owner.query(`CREATE FUNCTION public.mq_test_draft_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_DATABASE_FAILURE' USING ERRCODE='P0001'; END; $$`);
      await owner.query('CREATE TRIGGER mq_test_draft_failure AFTER INSERT ON story_revision FOR EACH ROW EXECUTE FUNCTION public.mq_test_draft_failure()');
      try {
        const result = await save(draft, "Synthetic rollback");
        assert.equal(result.status, 503); assert.equal(result.data.code, "ADMIN_UNAVAILABLE"); privateHeaders(result);
        assert.ok(!result.text.includes("SYNTHETIC_DATABASE_FAILURE"));
        assert.deepEqual(await snapshot(draft.id), before);
      } finally { await owner.query('DROP TRIGGER mq_test_draft_failure ON story_revision; DROP FUNCTION public.mq_test_draft_failure()'); }
    });
    await run("privilege drift fails closed and restoration recovers without changing data", async () => {
      const before = await snapshot(draft.id);
      await owner.query(`GRANT UPDATE (state) ON story TO "${runtimeRole}"`);
      try { assert.equal((await save(draft, "Must not save")).status, 503); }
      finally { await owner.query(`REVOKE UPDATE (state) ON story FROM "${runtimeRole}"`); }
      assert.deepEqual(await snapshot(draft.id), before);
      assert.equal((await request(path(draft.id), { jar: adminJar })).status, 200);
    });
    await run("draft reads and writes share the enforced database admission limit", async () => {
      assert.equal((await request("/api/admin/stories", { jar: adminJar })).status, 200);
      const before = await snapshot(draft.id);
      // Seed only the already-created counters in this disposable database to
      // avoid issuing thousands of requests. The next request must execute the
      // actual production consume path; no limiter function is mocked.
      await owner.query('UPDATE "AuthRateLimit" SET count=3001,"expiresAt"=CURRENT_TIMESTAMP+interval \'1 minute\'');
      for (const result of [await request(path(draft.id), { jar: adminJar }), await save(draft, "Rate limited edit")]) {
        assert.equal(result.status, 429); assert.equal(result.data.code, "ADMIN_RATE_LIMITED"); privateHeaders(result);
      }
      assert.deepEqual(await snapshot(draft.id), before);
    });
    await run("in-flight authorized save completes before revocation and old session immediately fails", async () => {
      await revisionGate(async unlock => {
        const saving = save(draft, "Before revocation");
        const settledSave = Promise.allSettled([saving]);
        await observeWait(owner, runtimeRole);
        const revoking = revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
        const settledRevoke = Promise.allSettled([revoking]);
        try { await observeWait(owner, maintenanceTarget.username, "wait_event <> 'advisory'"); }
        finally { await unlock(); }
        const saved = (await settledSave)[0]; const revoked = (await settledRevoke)[0];
        assert.equal(saved.status, "fulfilled"); assert.equal(saved.value.status, 200); draft = saved.value.data.story;
        assert.equal(revoked.status, "fulfilled"); grant = revoked.value;
      });
      assert.equal((await save(draft, "After revocation")).status, 401);
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      adminJar = await login();
    });
    await run("revocation holding the grant lock prevents a later in-flight save from committing", async () => {
      const before = await snapshot(draft.id);
      const key = randomBytes(4).readUInt32BE() % 2_000_000_000;
      const gate = await owner.connect();
      let pending = [];
      try {
        await owner.query(`CREATE FUNCTION public.mq_test_draft_revoke_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."kind"='REVOKED' THEN PERFORM pg_advisory_xact_lock(${key}); END IF; RETURN NEW; END; $$`);
        await owner.query('CREATE TRIGGER mq_test_draft_revoke_gate BEFORE INSERT ON "AdminSecurityEvent" FOR EACH ROW EXECUTE FUNCTION public.mq_test_draft_revoke_gate()');
        await gate.query("SELECT pg_advisory_lock($1)", [key]);
        const revoking = revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
        pending.push(revoking); const revocation = Promise.allSettled([revoking]);
        await observeWait(owner, maintenanceTarget.username);
        const saving = save(draft, "Must remain private local edit");
        pending.push(saving); const saved = Promise.allSettled([saving]);
        await observeWait(owner, runtimeRole, "wait_event <> 'advisory'");
        await gate.query("SELECT pg_advisory_unlock($1)", [key]);
        const revoked = (await revocation)[0]; const rejected = (await saved)[0];
        assert.equal(revoked.status, "fulfilled"); grant = revoked.value;
        assert.equal(rejected.status, "fulfilled"); assert.ok([401, 403].includes(rejected.value.status));
        assert.deepEqual(await snapshot(draft.id), before);
      } finally {
        await gate.query("SELECT pg_advisory_unlock($1)", [key]);
        await Promise.allSettled(pending);
        await owner.query('DROP TRIGGER IF EXISTS mq_test_draft_revoke_gate ON "AdminSecurityEvent"; DROP FUNCTION IF EXISTS public.mq_test_draft_revoke_gate()');
        gate.release();
      }
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      adminJar = await login();
    });
    await run("discarded network response is reconciled from versioned detail, without blind retry", async () => {
      const before = await snapshot(draft.id);
      await revisionGate(async unlock => {
        const outgoing = http.request(new URL(path(draft.id), origin), { method: "PUT", headers: { origin, "content-type": "application/json", cookie: adminJar.cookie } });
        const ended = new Promise(resolve => { outgoing.on("error", resolve); outgoing.on("response", response => { response.resume(); response.on("end", resolve); }); });
        outgoing.end(JSON.stringify({ expectedVersion: draft.version, title: "Synthetic uncertain response", content: content("Synthetic uncertain response") }));
        await observeWait(owner, runtimeRole);
        outgoing.destroy(new Error("Synthetic connection interrupted"));
        await ended; await unlock();
        // Observe the actual completed database work, not a claimed network success.
        for (let attempt = 0; attempt < 100; attempt++) {
          const active = (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1 AND state='active'", [runtimeRole])).rows[0].n;
          if (active === 0) break;
          await delay(20);
        }
      });
      const details = await request(path(draft.id), { jar: adminJar });
      assert.equal(details.status, 200); draft = details.data.story;
      const stored = await snapshot(draft.id);
      assert.ok([before.version, before.version + 1].includes(stored.version));
      assert.equal(stored.revisions, before.revisions + stored.version - before.version);
      assert.equal(draft.version, stored.version);
    });
    await run("expired and logged-out sessions cannot read or mutate private content", async () => {
      await sessionFixture.expire(owner, grant.userId);
      assert.equal((await request(path(draft.id), { jar: adminJar })).status, 401);
      adminJar = await login();
      const old = { ...adminJar };
      assert.equal((await request("/api/auth/sign-out", { method: "POST", body: {}, jar: adminJar })).status, 200);
      assert.equal((await save(draft, "Logged out", old)).status, 401);
      adminJar = await login();
    });
    await run("anonymous HTML, unknown public routes and error DTOs never expose private canaries", async () => {
      for (const route of ["/", `/stories/${draft.slug}`, "/api/stories", path(draft.id)]) {
        const response = await request(route);
        for (const canary of privateCanaries) assert.ok(!response.text.includes(canary));
      }
      // This remains a negative smoke check. The separate joint test above
      // verifies real public/share routes before and after a protected save.
    });
    return { passed, total: 20, secrets: [...secrets], admin, regular, privateCanaries, grant };
  } catch {
    console.error(`Draft HTTP failed at: ${stage} (raw values withheld)`);
    throw new Error("Draft HTTP regression failed");
  }
  finally { await Promise.allSettled([owner.end(), maintenance.$disconnect(), trusted.$disconnect()]); }
}

export async function runDraftHttpsTests({ connectionString, origin, backendOrigin, ca, credentials, secrets }) {
  assertTemporaryTarget(connectionString);
  const owner = new pg.Pool({ connectionString, max: 1 });
  const request = transport(origin, secrets, ca);
  const jar = {};
  let passed = 0;
  try {
    await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
    const login = await request("/api/auth/sign-in/username", { method: "POST", body: credentials.admin, jar });
    assert.equal(login.status, 200);
    const cookie = login.cookieLines.find(line => line.startsWith("__Secure-mq.session_token="));
    assert.ok(cookie); assert.match(cookie, /; Secure(?:;|$)/i); assert.match(cookie, /; HttpOnly(?:;|$)/i); assert.match(cookie, /SameSite=Lax/i);
    passed++; console.log("PASS draft HTTPS: production Secure/HttpOnly/SameSite cookie");
    const list = await request("/api/admin/stories", { jar });
    assert.equal(list.status, 200); privateHeaders(list);
    const created = await request("/api/admin/stories", { method: "POST", jar, body: { kind: "STAR", title: "Synthetic TLS draft", content: content("Synthetic TLS body") } });
    assert.equal(created.status, 201); assertSummary(created.data.story);
    const path = `/api/admin/stories/${created.data.story.id}/draft`;
    assert.equal((await request(path, { jar })).status, 200);
    assert.equal((await request(path, { method: "PUT", jar, body: { expectedVersion: 0, title: "Synthetic TLS update", content: content("Synthetic TLS update") } })).status, 200);
    passed++; console.log("PASS draft HTTPS: all four draft operations with a real TLS session");
    assert.equal((await request(path, { jar, requestOrigin: "https://attacker.example.invalid" })).status, 403);
    assert.equal((await transport(backendOrigin, secrets)("/api/admin/stories", { jar })).status, 403);
    passed++; console.log("PASS draft HTTPS: cross-origin and direct untrusted backend ingress denied");
    const copied = { ...jar };
    assert.equal((await request("/api/auth/sign-out", { method: "POST", body: {}, jar })).status, 200);
    assert.equal((await request(path, { jar: copied })).status, 401);
    passed++; console.log("PASS draft HTTPS: logout immediately invalidates the copied signed cookie");
    return { passed, total: 4 };
  } catch { throw new Error("Draft HTTPS assertion failed (raw values withheld)"); }
  finally { await owner.end(); }
}
