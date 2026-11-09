import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin } from "../../src/server/admin/maintenance.ts";
import { createStoryService } from "../../src/server/stories/service.ts";
import { observeWait } from "../admin-drafts/test-support.mjs";
import { transport, privateHeaders, assetDto } from "./upload-http-tests.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const v2 = (text, ...assets) => ({ version: 2, blocks: [
  { type: "paragraph", text, style: "emphasis" },
  ...assets.map((assetId, index) => ({ type: "image", assetId, alt: `合成测试配图 ${index + 1}`, caption: "合成演示 · 非私人照片" })),
  { type: "paragraph", text: "合成演示：图文内容仅用于隔离验收。", style: "strong" },
] });

/** Production HTTP + genuine PostgreSQL integration. Only this invocation's
 * random database and private directory are used. Lifecycle publication is an
 * explicit owner-side fixture operation, never a new public write endpoint. */
export async function runMediaStoryHttpTests({ connectionString, maintenanceUrl, runtimeUrl, runtimeRole,
  origin, ca, storageRoot, runBrowser, evidenceDirectory }) {
  const target = new URL(connectionString);
  assert.match(target.pathname, /^\/mq_test_admin_[a-f0-9]{32}$/); assert.equal(target.username, "mq_test");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.match(runtimeRole, /^mq_admin_rt_[a-f0-9]{32}$/);
  assert.equal(new URL(origin).protocol, "https:"); assert.ok(ca);
  for (const candidate of [maintenanceUrl, runtimeUrl]) {
    const url = new URL(candidate); assert.equal(url.host, target.host); assert.equal(url.pathname, target.pathname);
  }
  const owner = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 2, connectionTimeoutMillis: 5000 });
  const maintenance = createAuthDatabaseClient(maintenanceUrl), trusted = createAuthDatabaseClient(connectionString);
  const lifecycle = createStoryService(trusted), suffix = randomBytes(5).toString("hex");
  const admin = { username: `images_${suffix}`, password: `MqImages!${randomBytes(24).toString("base64url")}` };
  const regular = { username: `reader_${suffix}`, password: `MqReader!${randomBytes(24).toString("base64url")}` };
  const secrets = new Set([admin.password, regular.password, storageRoot]);
  const privateCanaries = [`PRIVATE_MEDIA_DRAFT_${randomUUID()}`, `PRIVATE_MEDIA_REVISION_${randomUUID()}`];
  const { request } = transport(origin, secrets, ca);
  const adminJar = {}, regularJar = {}, assets = [];
  let passed = 0, stage = "initialize private image/story integration", first, second, hidden;
  let initialPublicContent, updatedPublicContent;
  const draftPath = id => `/api/admin/stories/${id}/draft`;
  const contentPath = (story, asset) => `/api/stories/${story}/media/${asset}`;
  const assetPath = id => `/api/admin/media/${id}`;
  async function collectSecrets() {
    const rows = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT "tokenCiphertext" AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL UNION ALL SELECT storage_key::text AS value FROM media_asset')).rows;
    rows.forEach(row => secrets.add(row.value));
  }
  async function run(name, action) {
    stage = name; await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
    await action(); await collectSecrets(); passed++; console.log(`PASS story media: ${name}`);
  }
  async function create(title, content) {
    const response = await request("/api/admin/stories", { method: "POST", jar: adminJar, body: { kind: "STAR", title, content } });
    assert.equal(response.status, 201); privateHeaders(response); return response.data.story;
  }
  async function save(story, title, content) {
    return request(draftPath(story.id), { method: "PUT", jar: adminJar,
      body: { expectedVersion: story.version, title, content } });
  }
  async function current(id) { return (await owner.query("SELECT * FROM story WHERE id=$1", [id])).rows[0]; }
  async function refs(revision) {
    return (await owner.query("SELECT asset_id FROM story_revision_asset WHERE revision_id=$1 ORDER BY asset_id", [revision])).rows.map(row => row.asset_id);
  }
  async function count(id, expected) {
    const response = await request(assetPath(id), { jar: adminJar });
    assert.equal(response.status, 200); assetDto(response.data.asset);
    assert.equal(response.data.asset.publishedStoryCount, expected);
  }
  async function document(path, options = {}) {
    let response = await request(path, options);
    const canonicalRsc = options.headers?.rsc === "1" && response.status === 307;
    if (!canonicalRsc) assert.match(response.headers["cache-control"] ?? "", /no-store/);
    for (const marker of privateCanaries) assert.ok(!response.text.includes(marker));
    // Next 16 validates RSC cache-busting headers and canonically redirects a
    // header-only RSC request to the same document with its `_rsc` parameter.
    // Unlike fetch(), the raw TLS transport deliberately does not auto-follow.
    // Follow only this one same-origin/same-path framework normalization; the
    // final RSC body still receives all privacy assertions and must be 200.
    if (canonicalRsc) {
      // This framework redirect has no entity/body to cache. Its canonical URL
      // is not a permission result; the resulting RSC entity must be no-store.
      assert.equal(response.bytes.length, 0);
      assert.equal(typeof response.headers.location, "string");
      const destination = new URL(response.headers.location, origin);
      assert.equal(destination.origin, origin); assert.equal(destination.pathname, path);
      assert.deepEqual([...destination.searchParams.keys()], ["_rsc"]); assert.equal(destination.hash, "");
      response = await request(`${destination.pathname}${destination.search}`, options);
    }
    assert.equal(response.status, 200);
    assert.match(response.headers["cache-control"] ?? "", /no-store/);
    for (const marker of privateCanaries) assert.ok(!response.text.includes(marker));
    assert.match(response.headers["content-type"] ?? "", options.headers?.rsc === "1" ? /text\/x-component/ : /text\/html/);
    return response;
  }
  async function publicBytes(story, asset, status = 200, options = {}) {
    const response = await request(contentPath(story, asset), options);
    assert.equal(response.status, status); privateHeaders(response);
    if (status === 200 && options.method !== "HEAD") {
      assert.match(response.headers["content-type"], /^image\/webp/);
      const record = assets.find(item => item.id === asset); assert.ok(record);
      assert.equal(digest(response.bytes), record.display.sha256); assert.equal(response.bytes.length, record.display.byteLength);
    } else if (options.method === "HEAD") assert.equal(response.bytes.length, 0);
    else if (status === 404) assert.deepEqual(response.data, { code: "PUBLIC_MEDIA_NOT_FOUND" });
    else if (status === 503) assert.deepEqual(response.data, { code: "PUBLIC_MEDIA_UNAVAILABLE" });
    return response;
  }
  async function publish(story, slot) {
    let row = await current(story.id);
    if (slot) await lifecycle.reserveSlot({ storyId: story.id, expectedVersion: row.version, slotId: slot });
    row = await current(story.id); await lifecycle.publish({ storyId: story.id, expectedVersion: row.version });
    return (await request(draftPath(story.id), { jar: adminJar })).data.story;
  }
  async function snapshotDatabase() {
    return {
      stories: (await owner.query("SELECT id,version,state,draft_revision_id,published_revision_id FROM story ORDER BY id")).rows,
      revisions: (await owner.query("SELECT id,story_id FROM story_revision ORDER BY id")).rows,
      references: (await owner.query("SELECT revision_id,asset_id,required_state FROM story_revision_asset ORDER BY revision_id,asset_id")).rows,
      media: (await owner.query("SELECT id,state FROM media_asset ORDER BY id")).rows,
    };
  }
  try {
    await run("real uploads stay private and expose only safe zero-publication metadata", async () => {
      await initializeAdmin(maintenance, admin);
      assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: admin, jar: adminJar })).status, 200);
      assert.equal((await request("/api/auth/sign-up/email", { method: "POST", body: regular, jar: regularJar })).status, 200);
      const fixture = await readFile(new URL("../../public/scene/night-sky.webp", import.meta.url));
      for (let n = 0; n < 6; n++) {
        const bytes = await sharp(fixture).resize(640, 420, { fit: "cover" }).modulate({ hue: n * 12 }).png().toBuffer();
        const id = randomUUID(), uploaded = await request("/api/admin/media", { method: "POST", jar: adminJar, id, mime: "image/png", bytes });
        assert.equal(uploaded.status, 201); assetDto(uploaded.data.asset); assert.equal(uploaded.data.asset.publishedStoryCount, 0);
        assets.push(uploaded.data.asset);
        await publicBytes(randomUUID(), id, 404);
      }
      assert.deepEqual((await snapshotDatabase()).references, []);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story")).rows[0].n, 0);
    });
    await run("guest and ordinary identities cannot attach images or enumerate private usage", async () => {
      for (const [jar, status] of [[undefined, 401], [regularJar, 403]]) {
        const response = await request("/api/admin/stories", { method: "POST", jar,
          body: { kind: "STAR", title: "合成拒绝操作", content: v2("合成拒绝操作", assets[4].id) } });
        assert.equal(response.status, status);
        for (const path of ["/api/admin/media", assetPath(assets[4].id), `${assetPath(assets[4].id)}/content`]) {
          assert.equal((await request(path, { jar })).status, status);
        }
      }
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story")).rows[0].n, 0);
    });
    await run("v2 draft HTTP writes generate exact immutable image references without publication", async () => {
      first = await create(privateCanaries[0], v2(privateCanaries[0], assets[0].id, assets[0].id));
      const row = await current(first.id); assert.equal(row.state, "DRAFT"); assert.equal(row.slot_id, null);
      assert.deepEqual(await refs(row.draft_revision_id), [assets[0].id]);
      const detail = await request(draftPath(first.id), { jar: adminJar });
      assert.deepEqual(detail.data.draft.content, v2(privateCanaries[0], assets[0].id, assets[0].id));
      assert.equal((await request(`/api/stories/${first.id}`)).status, 404);
      await publicBytes(first.id, assets[0].id, 404); await count(assets[0].id, 0);
    });
    await run("bad v2 references and forged URL fields fail without orphan revisions or associations", async () => {
      const pending = randomUUID(); await owner.query("INSERT INTO media_asset(id) VALUES($1)", [pending]);
      const before = await snapshotDatabase();
      for (const content of [v2("Missing asset", randomUUID()), v2("Pending asset", pending),
        { version: 2, blocks: [{ type: "image", assetId: assets[0].id, alt: "Synthetic", src: "https://example.invalid/private" }] },
        { version: 2, blocks: [{ type: "image", assetId: "../private", alt: "Synthetic" }] }]) {
        const response = await save(first, "Rejected synthetic change", content); assert.equal(response.status, 400);
        assert.deepEqual(await snapshotDatabase(), before);
      }
      // Measure PostgreSQL's actual jsonb formatting rather than reproducing
      // the application's byte-count formula. Compact JSON remains below the
      // limit even when structural spaces make the next byte invalid.
      const bounded = { version: 2, blocks: Array.from({ length: 30 }, () => ({ type: "paragraph", text: "x" })) };
      const pgBytes = async content => (await owner.query("SELECT octet_length($1::jsonb::text)::int AS n", [JSON.stringify(content)])).rows[0].n;
      let remaining = 256 * 1024 - await pgBytes(bounded);
      for (const block of bounded.blocks) {
        const extra = Math.min(9999, remaining); block.text += "x".repeat(extra); remaining -= extra;
      }
      assert.equal(remaining, 0); assert.equal(await pgBytes(bounded), 262144);
      const boundary = await create("合成JSONB边界验收", bounded);
      assert.equal((await owner.query("SELECT octet_length(content::text)::int AS n FROM story_revision WHERE story_id=$1", [boundary.id])).rows[0].n, 262144);
      bounded.blocks.at(-1).text += "x";
      assert.equal(await pgBytes(bounded), 262145); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 262144);
      const beforeOversize = await snapshotDatabase();
      assert.equal((await save(boundary, "合成拒绝超限内容", bounded)).status, 400);
      assert.deepEqual(await snapshotDatabase(), beforeOversize);
    });
    await run("genuinely overlapping HTTP saves have one CAS winner and no losing revision or image projection", async () => {
      const key = randomBytes(4).readUInt32BE() % 2_000_000_000, gate = await owner.connect();
      const before = await snapshotDatabase(); let attempts = [];
      try {
        await owner.query(`CREATE FUNCTION mq_test_media_cas_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(${key}); RETURN NEW; END $$`);
        await owner.query("CREATE TRIGGER mq_test_media_cas_gate BEFORE INSERT ON story_revision FOR EACH ROW EXECUTE FUNCTION mq_test_media_cas_gate()");
        await gate.query("SELECT pg_advisory_lock($1)", [key]);
        attempts = [1, 2].map(n => save(first, `Synthetic race ${n}`, v2(`Synthetic race ${n}`, assets[n].id)));
        await observeWait(owner, runtimeRole, "wait_event='advisory'", 2);
        await gate.query("SELECT pg_advisory_unlock($1)", [key]);
        const responses = await Promise.all(attempts);
        assert.deepEqual(responses.map(value => value.status).sort(), [200, 409]);
        const winner = responses.findIndex(value => value.status === 200); first = responses[winner].data.story;
        const after = await snapshotDatabase();
        assert.equal(after.revisions.length, before.revisions.length + 1); assert.equal(after.references.length, before.references.length + 1);
        assert.deepEqual(await refs((await current(first.id)).draft_revision_id), [assets[winner + 1].id]);
        assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_revision_asset WHERE asset_id=$1", [assets[(winner === 0 ? 2 : 1)].id])).rows[0].n, 0);
      } finally {
        await gate.query("SELECT pg_advisory_unlock($1)", [key]);
        await Promise.allSettled(attempts);
        await owner.query("DROP TRIGGER IF EXISTS mq_test_media_cas_gate ON story_revision; DROP FUNCTION IF EXISTS mq_test_media_cas_gate()"); gate.release();
      }
    });
    await run("current published v2 serves only its exact display image through real guest GET and HEAD", async () => {
      initialPublicContent = v2("合成演示：第一封公开的星光信。", assets[0].id);
      const saved = await save(first, "合成公开故事 · 星光与山坡", initialPublicContent); assert.equal(saved.status, 200); first = saved.data.story;
      first = await publish(first, "star-1");
      for (const route of [`/api/stories/${first.id}`, `/api/stories/by-slug/${first.slug}`]) {
        const response = await request(route); assert.equal(response.status, 200); assert.deepEqual(response.data.story.content, initialPublicContent);
      }
      await publicBytes(first.id, assets[0].id); await publicBytes(first.id, assets[0].id, 200, { method: "HEAD" });
      await publicBytes(first.id, assets[0].id, 200, { jar: regularJar });
      await publicBytes(first.id, assets[4].id, 404); await count(assets[0].id, 1);
    });
    await run("saving unpublished image changes keeps old public body, bytes and metadata isolated", async () => {
      const saved = await save(first, privateCanaries[1], v2(privateCanaries[1], assets[3].id));
      assert.equal(saved.status, 200); first = saved.data.story;
      const body = await request(`/api/stories/${first.id}`); assert.deepEqual(body.data.story.content, initialPublicContent);
      assert.ok(!body.text.includes(privateCanaries[1])); await publicBytes(first.id, assets[0].id); await publicBytes(first.id, assets[3].id, 404);
      await count(assets[0].id, 1); await count(assets[3].id, 0);
    });
    await run("explicit cross-story reuse counts current published stories once and preserves pair-based authorization", async () => {
      second = await create("合成公开故事 · 另一封回信", v2("合成演示：同一素材在另一篇故事中明确复用。", assets[0].id, assets[0].id));
      second = await publish(second, "star-2");
      await count(assets[0].id, 2); await publicBytes(first.id, assets[0].id); await publicBytes(second.id, assets[0].id);
      await publicBytes(second.id, assets[3].id, 404); await publicBytes(second.id, assets[4].id, 404);
      const list = await request("/api/admin/media?limit=50", { jar: adminJar }); assert.equal(list.status, 200);
      assert.equal(list.data.items.find(item => item.id === assets[0].id).publishedStoryCount, 2); list.data.items.forEach(assetDto);
      assert.ok(!list.text.includes(first.id) && !list.text.includes(second.id), "Usage counters must not disclose story identities");
    });
    await run("publishing an explicit update revokes old pair URLs while another story keeps its own shared image", async () => {
      updatedPublicContent = v2("合成演示：发布更新后的星光图文。", assets[3].id);
      const saved = await save(first, "合成公开故事 · 星光新一页", updatedPublicContent); assert.equal(saved.status, 200); first = saved.data.story;
      first = await publish(first);
      assert.deepEqual((await request(`/api/stories/${first.id}`)).data.story.content, updatedPublicContent);
      await publicBytes(first.id, assets[0].id, 404); await publicBytes(first.id, assets[3].id); await publicBytes(second.id, assets[0].id);
      await count(assets[0].id, 1); await count(assets[3].id, 1);
    });
    await run("withdrawal and restoration change new public image requests and live reuse counts immediately", async () => {
      for (const [story, image, title] of [[first, assets[3], "合成公开故事 · 星光新一页"], [second, assets[0], "合成公开故事 · 另一封回信"]]) {
        const label = story.id === first.id ? "first story" : "shared second story";
        stage = `withdrawal: ${label} owner transition`;
        let row = await current(story.id); await lifecycle.withdraw({ storyId: story.id, expectedVersion: row.version });
        stage = `withdrawal: ${label} GET/HEAD and live count`;
        await publicBytes(story.id, image.id, 404); await publicBytes(story.id, image.id, 404, { method: "HEAD" }); await count(image.id, 0);
        stage = `withdrawal: ${label} public body API`;
        assert.equal((await request(`/api/stories/${story.id}`)).status, 404);
        for (const headers of [{ "user-agent": "Twitterbot/1.0" }, { rsc: "1" }]) {
          stage = `withdrawal: ${label} ${headers.rsc ? "RSC" : "bot HTML"} title and image isolation`;
          const page = await document(`/stories/${story.slug}`, { headers });
          assert.ok(!page.text.includes(title)); assert.ok(!page.text.includes(contentPath(story.id, image.id)));
        }
        stage = `restoration: ${label} owner transition and fresh image/count`;
        row = await current(story.id); await lifecycle.restore({ storyId: story.id, expectedVersion: row.version });
        await publicBytes(story.id, image.id); await count(image.id, 1);
      }
    });
    await run("conditions, range, optimizer, query variants and traversal never bypass current publication", async () => {
      const conditions = { "if-none-match": "*", "if-modified-since": "Wed, 01 Jan 2099 00:00:00 GMT", range: "bytes=0-20" };
      for (const method of ["GET", "HEAD"]) {
        const response = await publicBytes(first.id, assets[3].id, 200, { method, headers: conditions });
        assert.equal(response.headers["content-range"], undefined);
        await publicBytes(first.id, assets[4].id, 404, { method, headers: conditions });
      }
      for (const query of ["variant=thumbnail", "variant=display", "path=../../private", "x=1"]) {
        const response = await request(`${contentPath(first.id, assets[3].id)}?${query}`);
        assert.equal(response.status, 400); assert.deepEqual(response.data, { code: "PUBLIC_MEDIA_REQUEST_REJECTED" }); privateHeaders(response);
      }
      for (const path of [contentPath(first.id, assets[3].id), contentPath(first.id, assets[4].id), `${assetPath(assets[4].id)}/content`]) {
        for (const jar of [undefined, adminJar]) assert.equal((await request(`/_next/image?url=${encodeURIComponent(path)}&w=640&q=75`, { jar })).status, 400);
      }
      for (const id of ["not-a-uuid", "%2e%2e%2fprivate", `${assets[3].id}%2Fthumbnail`]) {
        const response = await request(`/api/stories/${first.id}/media/${id}`); assert.ok([400, 404].includes(response.status));
        assert.ok(!response.headers["content-type"]?.startsWith("image/"));
      }
      assert.equal((await request(contentPath(first.id, assets[3].id), { method: "POST", body: {} })).status, 405);
    });
    await run("database, missing-file and hash failures fail closed without exposing a private path", async () => {
      await owner.query(`REVOKE SELECT ON story_revision_asset FROM "${runtimeRole}"`);
      try {
        await publicBytes(first.id, assets[3].id, 503);
        await publicBytes(first.id, assets[3].id, 503, { method: "HEAD" });
      }
      finally { await owner.query(`GRANT SELECT ON story_revision_asset TO "${runtimeRole}"`); }
      const row = (await owner.query("SELECT storage_key FROM media_asset WHERE id=$1", [assets[3].id])).rows[0]; secrets.add(row.storage_key);
      const path = join(storageRoot, row.storage_key, "display.webp"), backup = join(storageRoot, row.storage_key, "synthetic-missing-file-test.webp");
      await rename(path, backup);
      try {
        await publicBytes(first.id, assets[3].id, 503);
        await publicBytes(first.id, assets[3].id, 503, { method: "HEAD" });
      }
      finally { await rename(backup, path); }
      const original = await readFile(path);
      try { await writeFile(path, Buffer.concat([original, Buffer.from("synthetic-corruption")])); await publicBytes(first.id, assets[3].id, 503); }
      finally { await writeFile(path, original); }
      await publicBytes(first.id, assets[3].id);
    });
    await run("HTML, RSC, metadata and public APIs never expose unsubmitted or historic private drafts", async () => {
      hidden = await create(privateCanaries[0], v2(privateCanaries[0], assets[4].id));
      for (const story of [hidden, first]) {
        for (const options of [{}, { headers: { rsc: "1" } }, { headers: { "user-agent": "Twitterbot/1.0" } }]) {
          const response = await document(`/stories/${story.slug}`, options);
          for (const marker of privateCanaries) assert.ok(!response.text.includes(marker));
          assert.ok(!response.text.includes(contentPath(hidden.id, assets[4].id)));
        }
      }
      for (const route of ["/api/stories", `/api/stories/${first.id}`, `/api/stories/by-slug/${first.slug}`]) {
        const response = await request(route); assert.equal(response.status, 200);
        for (const marker of privateCanaries) assert.ok(!response.text.includes(marker));
      }
      assert.equal((await request(`/api/stories/${hidden.id}`)).status, 404);
      assert.equal((await request(`/api/stories/by-slug/${hidden.slug}`)).status, 404);
      await publicBytes(hidden.id, assets[4].id, 404); await count(assets[4].id, 0);
    });
    await run("the combined runtime reads projections but cannot edit history, publication, identity or referenced-image lifetime", async () => {
      assert.ok((await runtime.query("SELECT count(*)::int AS n FROM story_revision_asset")).rows[0].n > 0);
      for (const sql of ["UPDATE story SET state='PUBLISHED' WHERE false", "UPDATE story SET published_revision_id=NULL WHERE false",
        "UPDATE story_revision SET content='{}'::jsonb WHERE false", "DELETE FROM story_revision_asset WHERE false",
        "UPDATE media_asset SET storage_key=gen_random_uuid() WHERE false", 'UPDATE "AdminGrant" SET "revokedAt"=NULL WHERE false']) {
        assert.equal(await runtime.query(sql).then(() => "SUCCESS", error => error.code), "42501");
      }
      assert.equal(await runtime.query("UPDATE media_asset SET state='DELETING' WHERE id=$1", [assets[0].id]).then(() => "SUCCESS", error => error.code), "23001");
      await publicBytes(second.id, assets[0].id);
    });
    if (runBrowser) {
      stage = "real production managed-media editor and reader browser regression";
      await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
      await runBrowser({ baseURL: origin, admin, regular,
        publicStory: { id: first.id, slug: first.slug, title: "合成公开故事 · 星光新一页" },
        privateAssetId: assets[4].id, readyAssets: assets.map(({ id }) => ({ id })),
        privateDraft: { id: hidden.id, slug: hidden.slug }, privateCanaries,
        // Browser uploads intentionally add MediaAsset rows. Its no-auto-save
        // proof concerns story identities, immutable revisions and references.
        snapshotDatabase: async () => {
          const { stories, revisions, references } = await snapshotDatabase();
          return { stories, revisions, references };
        }, evidenceDirectory });
      await collectSecrets();
    }
  } catch (error) {
    const location = /(?:story-http-tests|upload-http-tests)\.mjs:(\d+):(\d+)/.exec(error?.stack ?? "");
    const safe = new Error("MEDIA_STORY_TEST_FAILED");
    safe.stage = error?.message === "MEDIA_STORY_BROWSER_FAILED" && typeof error.stage === "string" ? error.stage : stage;
    if (location) safe.stage += ` [test source line ${location[1]}:${location[2]}]`;
    if (typeof error?.actual === "number" && typeof error?.expected === "number") {
      safe.stage += ` [numeric actual=${error.actual}, expected=${error.expected}]`;
    }
    safe.code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR"; throw safe;
  } finally { await Promise.allSettled([owner.end(), runtime.end(), maintenance.$disconnect(), trusted.$disconnect()]); }
  return { passed, total: 14, secrets: [...secrets], privateCanaries };
}
