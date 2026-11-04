import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin, revokeAdmin, restoreAdmin } from "../../src/server/admin/maintenance.ts";
import { transport, privateHeaders } from "../media/upload-http-tests.mjs";
import { assertTemporaryTarget, observeWait } from "../admin-drafts/test-support.mjs";

const paragraph = text => ({ version: 1, blocks: [{ type: "paragraph", text }] });
const illustrated = (text, assetId) => ({ version: 2, blocks: [
  { type: "paragraph", text }, { type: "image", assetId, alt: "合成发布验收图片", caption: "合成数据，非私人照片" },
] });

/** Every publication below uses the real HTTP handler. Owner access is limited
 * to inspecting fixtures, injecting controlled faults and observing DB locks. */
export async function runPublishingHttpTests({ connectionString, maintenanceUrl, runtimeRole, origin, ca, storageRoot, gateFile }) {
  assertTemporaryTarget(connectionString); assertTemporaryTarget(maintenanceUrl);
  const owner = new pg.Pool({ connectionString, max: 5 });
  const maintenance = createAuthDatabaseClient(maintenanceUrl);
  const suffix = randomBytes(5).toString("hex");
  const admin = { username: `publish_${suffix}`, password: `MqPublish!${randomBytes(24).toString("base64url")}` };
  const regular = { username: `reader_${suffix}`, password: `MqReader!${randomBytes(24).toString("base64url")}` };
  const secrets = new Set([admin.password, regular.password, storageRoot]);
  const { request } = transport(origin, secrets, ca);
  let jar = {}, ordinaryJar = {}, grant, first, campfire, assets, passed = 0, stage = "setup";
  const path = (id, action) => `/api/admin/stories/${id}/${action}`;
  const current = async id => (await owner.query("SELECT * FROM story WHERE id=$1", [id])).rows[0];
  const privateTitle = `PRIVATE_UNCONFIRMED_${randomUUID()}`;
  async function collectSecrets() {
    const rows = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL UNION ALL SELECT storage_key::text AS value FROM media_asset')).rows;
    rows.forEach(row => secrets.add(row.value));
  }
  async function run(name, action) {
    stage = name;
    await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
    await action(); await collectSecrets(); passed++; console.log(`PASS publication HTTP: ${name}`);
  }
  async function login() {
    const next = {};
    const response = await request("/api/auth/sign-in/username", { method: "POST", body: admin, jar: next });
    assert.equal(response.status, 200); assert.ok(next.cookie);
    if (ca) assert.ok(response.cookieLines.some(line => /^__Secure-mq\.session_token=/.test(line) && /; Secure/i.test(line)));
    return next;
  }
  async function create(title, content, kind = "STAR") {
    const response = await request("/api/admin/stories", { method: "POST", jar, body: { kind, title, content } });
    assert.equal(response.status, 201); return response.data.story;
  }
  async function save(id, title, content) {
    const story = await current(id);
    const response = await request(path(id, "draft"), { method: "PUT", jar, body: { expectedVersion: story.version, title, content } });
    assert.equal(response.status, 200); return response.data.story;
  }
  async function action(id, name, extra = {}, expected = 200) {
    const story = await current(id);
    const response = await request(path(id, name), { method: name === "slot" ? "PUT" : "POST", jar,
      body: { expectedVersion: story.version, ...extra } });
    assert.equal(response.status, expected); privateHeaders(response);
    if (expected === 200) {
      assert.equal(response.data.story.id, id); assert.equal(response.data.story.version, story.version + 1);
      assert.deepEqual(Object.keys(response.data.story).sort(), ["id", "version", "state", "slotId", "hasUnpublishedChanges"].sort());
    }
    return response;
  }
  async function documents(story, title, absent = []) {
    for (const headers of [{}, { rsc: "1" }, { "user-agent": "Twitterbot/1.0" }]) {
      let response = await request(`/stories/${story.slug}`, { headers });
      if (response.status === 307 && headers.rsc) {
        const next = new URL(response.headers.location, origin);
        assert.equal(next.origin, origin); assert.equal(next.pathname, `/stories/${story.slug}`);
        response = await request(`${next.pathname}${next.search}`, { headers });
      }
      assert.equal(response.status, 200); assert.match(response.headers["cache-control"] ?? "", /no-store/);
      for (const marker of absent) assert.ok(!response.text.includes(marker));
      if (!headers.rsc) assert.ok(response.text.includes(`<title>${title ?? "故事暂不可用"} · MQ · Our Stories</title>`));
    }
  }
  async function publicState(story, { title, asset, forbidden = [] }) {
    for (const route of [`/api/stories/${story.id}`, `/api/stories/by-slug/${story.slug}`]) {
      const response = await request(route); assert.equal(response.status, title ? 200 : 404); privateHeaders(response);
      if (title) assert.equal(response.data.story.title, title);
      for (const marker of forbidden) assert.ok(!response.text.includes(marker));
    }
    await documents(story, title, forbidden);
    for (const image of assets) for (const method of ["GET", "HEAD"]) {
      const response = await request(`/api/stories/${story.id}/media/${image.id}`, {
        method, headers: { "if-none-match": '"synthetic"', "if-modified-since": "Wed, 01 Jan 2031 00:00:00 GMT" },
      });
      assert.equal(response.status, title && asset === image.id ? 200 : 404); privateHeaders(response);
      if (method === "HEAD") assert.equal(response.bytes.length, 0);
    }
  }
  async function pausedFile(asset, operation) {
    const row = (await owner.query("SELECT storage_key FROM media_asset WHERE id=$1", [asset])).rows[0];
    const nonce = randomUUID(), config = { nonce, target: join(storageRoot, row.storage_key, "display.webp"),
      entered: `${gateFile}.${nonce}.entered`, release: `${gateFile}.${nonce}.release` };
    await writeFile(gateFile, JSON.stringify(config), { mode: 0o600 });
    const before = await current(first.id);
    const pending = request(path(first.id, "publish"), { method: "POST", jar, body: { expectedVersion: before.version } });
    try {
      let entered = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        try { entered = (await readFile(config.entered, "utf8")) === nonce; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (entered) break; await delay(15);
      }
      assert.ok(entered, "Publication must reach the real file-open barrier");
      await operation(before);
      await writeFile(config.release, nonce, { mode: 0o600 });
      return await pending;
    } finally {
      await writeFile(config.release, nonce, { mode: 0o600 }); await Promise.allSettled([pending]);
      await Promise.all([gateFile, config.entered, config.release].map(file => rm(file, { force: true })));
    }
  }
  try {
    await run("guest, ordinary user and forged role cannot use any publishing endpoint", async () => {
      const operations = [["/api/admin/star-slots", {}], [path(randomUUID(), "slot"), { method: "PUT", body: { expectedVersion: 0, slotId: "star-1" } }],
        ...["publish", "withdraw", "restore"].map(name => [path(randomUUID(), name), { method: "POST", body: { expectedVersion: 0 } }])];
      for (const [route, options] of operations) assert.equal((await request(route, options)).status, 401);
      assert.equal((await request("/api/auth/sign-up/email", { method: "POST", jar: ordinaryJar, body: regular })).status, 200);
      for (const [route, options] of operations) assert.equal((await request(route, { ...options, jar: ordinaryJar, headers: { "x-role": "admin" } })).status, 403);
      grant = await initializeAdmin(maintenance, admin); jar = await login();
    });
    await run("real private upload and current draft remain unpublished until explicit publishing", async () => {
      assets = [];
      for (const color of ["#234567", "#cd7854"]) {
        const bytes = await sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).png().toBuffer();
        const response = await request("/api/admin/media", { method: "POST", jar, id: randomUUID(), mime: "image/png", bytes });
        assert.equal(response.status, 201); assets.push(response.data.asset);
      }
      first = await create("合成故事·首次发布", illustrated("合成公开正文第一版", assets[0].id));
      await publicState(first, { forbidden: ["合成公开正文第一版"] });
      await action(first.id, "publish", {}, 409);
      await action(first.id, "slot", { slotId: "star-1" });
      const slots = await request("/api/admin/star-slots", { jar }); assert.equal(slots.status, 200); privateHeaders(slots);
      assert.ok(slots.text.includes(first.id)); assert.ok(slots.text.includes("star-1"));
      await action(first.id, "publish");
      await publicState(first, { title: "合成故事·首次发布", asset: assets[0].id });
    });
    await run("new draft does not alter public API, share metadata or image permission", async () => {
      await save(first.id, "合成故事·明确更新", illustrated("合成公开正文第二版", assets[1].id));
      await publicState(first, { title: "合成故事·首次发布", asset: assets[0].id, forbidden: ["合成故事·明确更新", "合成公开正文第二版"] });
      await action(first.id, "publish");
      await publicState(first, { title: "合成故事·明确更新", asset: assets[1].id, forbidden: ["合成公开正文第一版"] });
      await action(first.id, "slot", { slotId: "star-2" }, 409);
      await action(first.id, "publish", {}, 409);
    });
    await run("withdraw and restore retain original public revision and suppress unconfirmed draft", async () => {
      await save(first.id, privateTitle, illustrated(privateTitle, assets[0].id));
      const before = await current(first.id);
      await action(first.id, "withdraw");
      await publicState(first, { forbidden: [privateTitle, "合成故事·明确更新"] });
      await action(first.id, "slot", { slotId: null }, 409);
      await action(first.id, "publish", {}, 409);
      await action(first.id, "restore");
      assert.equal((await current(first.id)).published_revision_id, before.published_revision_id);
      await publicState(first, { title: "合成故事·明确更新", asset: assets[1].id, forbidden: [privateTitle] });
    });
    await run("slot contention has one winner and CAMPFIRE remains slot-free", async () => {
      const candidates = await Promise.all([create("合成星位竞争一", paragraph("合成内容一")), create("合成星位竞争二", paragraph("合成内容二"))]);
      const responses = await Promise.all(candidates.map(story => request(path(story.id, "slot"), { method: "PUT", jar, body: { expectedVersion: story.version, slotId: "star-2" } })));
      assert.deepEqual(responses.map(item => item.status).sort(), [200, 409]);
      const winner = candidates[responses.findIndex(item => item.status === 200)];
      await action(winner.id, "publish");
      const loser = candidates[responses.findIndex(item => item.status === 409)];
      assert.equal((await current(loser.id)).slot_id, null); assert.equal((await current(loser.id)).version, 0);
      await action(loser.id, "slot", { slotId: "star-3" }); await action(loser.id, "slot", { slotId: null });
      campfire = await create("合成篝火故事", paragraph("合成篝火正文"), "CAMPFIRE");
      await action(campfire.id, "slot", { slotId: "star-3" }, 409); await action(campfire.id, "publish");
      assert.equal((await current(campfire.id)).slot_id, null);
    });
    await run("same-version concurrent publish has one CAS winner without extra revisions", async () => {
      await save(first.id, "合成故事·并发发布", illustrated("合成并发公开内容", assets[1].id));
      const before = await current(first.id), count = (await owner.query("SELECT count(*)::int AS n FROM story_revision")).rows[0].n;
      const responses = await Promise.all([1, 2].map(() => request(path(first.id, "publish"), { method: "POST", jar, body: { expectedVersion: before.version } })));
      assert.deepEqual(responses.map(item => item.status).sort(), [200, 409]);
      assert.equal((await current(first.id)).version, before.version + 1);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_revision")).rows[0].n, count);
    });
    await run("missing and hash-damaged files prevent publish and restore without state changes", async () => {
      await save(first.id, "合成故事·待完整性校验", illustrated("合成完整性正文", assets[0].id));
      const metadata = (await owner.query("SELECT storage_key FROM media_asset WHERE id=$1", [assets[0].id])).rows[0];
      const file = join(storageRoot, metadata.storage_key, "display.webp"), hidden = `${file}.test-held`;
      const before = await current(first.id); await rename(file, hidden);
      try { await action(first.id, "publish", {}, 503); assert.deepEqual(await current(first.id), before); }
      finally { await rename(hidden, file); }
      const original = await readFile(file); const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1;
      await writeFile(file, damaged);
      try { await action(first.id, "publish", {}, 503); assert.deepEqual(await current(first.id), before); }
      finally { await writeFile(file, original); }
      await action(first.id, "publish"); await action(first.id, "withdraw");
      const withdrawn = await current(first.id); await rename(file, hidden);
      try { await action(first.id, "restore", {}, 503); assert.deepEqual(await current(first.id), withdrawn); }
      finally { await rename(hidden, file); }
      await action(first.id, "restore");
    });
    await run("bad parameters and cross-site requests fail without changing saved or public state", async () => {
      const before = await current(first.id);
      for (const body of [{ expectedVersion: -1 }, { expectedVersion: before.version, revisionId: randomUUID() },
        { expectedVersion: before.version, state: "PUBLISHED" }, { expectedVersion: String(before.version) }]) {
        assert.equal((await request(path(first.id, "publish"), { method: "POST", jar, body })).status, 400);
      }
      assert.equal((await request(path(first.id, "withdraw"), { method: "POST", jar, requestOrigin: "https://external.invalid", body: { expectedVersion: before.version } })).status, 403);
      assert.deepEqual(await current(first.id), before);
    });
    await run("a draft saved during real file I/O invalidates publication without long authorization locks", async () => {
      await save(first.id, "合成文件检查前草稿", illustrated("合成文件检查内容", assets[0].id));
      const before = await current(first.id);
      const response = await pausedFile(assets[0].id, async () => {
        // Change the draft before I/O resumes, then require the final CAS to
        // reject the stale preflight instead of publishing the replacement.
        await save(first.id, "合成文件检查中新草稿", illustrated("合成并发编辑内容", assets[1].id));
      });
      assert.equal(response.status, 409);
      const after = await current(first.id); assert.equal(after.version, before.version + 1);
      assert.equal(after.published_revision_id, before.published_revision_id);
    });
    await run("revocation during real file I/O completes and prevents the final publication", async () => {
      await save(first.id, "合成读取期间撤权", illustrated("合成撤权文件检查", assets[0].id));
      const before = await current(first.id);
      const response = await pausedFile(assets[0].id, async () => {
        grant = await revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      });
      assert.equal(response.status, 401); assert.deepEqual(await current(first.id), before);
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version }); jar = await login();
    });
    await run("transaction error rolls back publication and exposes no raw database detail", async () => {
      await save(first.id, "合成回滚草稿", illustrated("合成回滚正文", assets[0].id));
      const before = await current(first.id);
      await owner.query("CREATE FUNCTION public.mq_test_publish_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PUBLISH_DATABASE_FAILURE'; END; $$");
      await owner.query("CREATE TRIGGER mq_test_publish_failure AFTER UPDATE OF published_revision_id ON story FOR EACH ROW EXECUTE FUNCTION public.mq_test_publish_failure()");
      try { await action(first.id, "publish", {}, 503); assert.deepEqual(await current(first.id), before); }
      finally { await owner.query("DROP TRIGGER mq_test_publish_failure ON story; DROP FUNCTION public.mq_test_publish_failure()"); }
    });
    await run("publication authorization locks serialize an in-flight revoke", async () => {
      const key = randomBytes(4).readUInt32BE() % 2_000_000_000;
      const gate = await owner.connect(); let pending, revoke;
      await owner.query(`CREATE FUNCTION public.mq_test_publish_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(${key}); RETURN NEW; END; $$`);
      await owner.query("CREATE TRIGGER mq_test_publish_gate BEFORE UPDATE OF published_revision_id ON story FOR EACH ROW EXECUTE FUNCTION public.mq_test_publish_gate()");
      try {
        await gate.query("SELECT pg_advisory_lock($1)", [key]);
        const before = await current(first.id);
        pending = request(path(first.id, "publish"), { method: "POST", jar, body: { expectedVersion: before.version } });
        await observeWait(owner, runtimeRole);
        revoke = revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
        await observeWait(owner, new URL(maintenanceUrl).username, "wait_event IN ('transactionid','tuple')");
        await gate.query("SELECT pg_advisory_unlock($1)", [key]);
        assert.equal((await pending).status, 200); grant = await revoke;
        assert.equal((await request(path(first.id, "withdraw"), { method: "POST", jar, body: { expectedVersion: before.version + 1 } })).status, 401);
      } finally {
        await gate.query("SELECT pg_advisory_unlock($1)", [key]);
        await Promise.allSettled([pending, revoke]);
        await owner.query("DROP TRIGGER mq_test_publish_gate ON story; DROP FUNCTION public.mq_test_publish_gate()"); gate.release();
      }
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version }); jar = await login();
    });
    await run("revoked, expired, logged-out and forged sessions cannot publish", async () => {
      const before = await current(first.id);
      await owner.query('UPDATE "Session" SET "expiresAt"=now()-interval \'1 minute\' WHERE "userId"=$1', [grant.userId]);
      assert.equal((await request(path(first.id, "withdraw"), { method: "POST", jar, body: { expectedVersion: before.version } })).status, 401, "expired session rejected");
      jar = await login(); const old = { ...jar };
      assert.equal((await request("/api/auth/sign-out", { method: "POST", jar, body: {} })).status, 200, "JSON sign-out succeeds");
      assert.equal((await request(path(first.id, "withdraw"), { method: "POST", jar: old, body: { expectedVersion: before.version } })).status, 401, "logged-out session rejected");
      assert.equal((await request(path(first.id, "withdraw"), { method: "POST", jar: { cookie: `${ca ? "__Secure-" : ""}mq.session_token=forged` }, body: { expectedVersion: before.version } })).status, 401, "forged session rejected");
      assert.deepEqual(await current(first.id), before); jar = await login();
    });
    await run("a revoke holding the grant lock wins before an in-flight publication", async () => {
      await save(first.id, "合成撤权竞争草稿", illustrated("合成撤权竞争正文", assets[0].id));
      const before = await current(first.id), lock = await owner.connect(); let pending;
      try {
        await lock.query("BEGIN");
        await lock.query('UPDATE "AdminGrant" SET "revokedAt"=clock_timestamp(),version=version+1 WHERE id=1');
        pending = request(path(first.id, "publish"), { method: "POST", jar, body: { expectedVersion: before.version } });
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')");
        await lock.query("COMMIT");
        assert.equal((await pending).status, 403); assert.deepEqual(await current(first.id), before);
      } finally { await lock.query("ROLLBACK"); await Promise.allSettled([pending]); lock.release(); }
      grant = (await owner.query('SELECT "userId",version FROM "AdminGrant" WHERE id=1')).rows[0];
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version }); jar = await login();
    });
    await run("final public state retains the approved layout and stable slug", async () => {
      await save(first.id, "合成发布验收 · 羽毛信", illustrated("合成文章，仅用于发布后端和既有阅读器回归。", assets[0].id));
      await action(first.id, "publish");
      await publicState(first, { title: "合成发布验收 · 羽毛信", asset: assets[0].id, forbidden: [privateTitle] });
      assert.equal((await current(first.id)).slug, first.slug);
    });
    return { passed, total: 15, admin, regular, secrets, first: { ...first, title: "合成发布验收 · 羽毛信" }, privateCanaries: [privateTitle] };
  } catch (error) { error.publishingStage = stage; throw error; }
  finally { await Promise.allSettled([owner.end(), maintenance.$disconnect()]); }
}
