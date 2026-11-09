import { sessionFixture } from "../auth/session-fixture.mjs";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin, revokeAdmin, restoreAdmin } from "../../src/server/admin/maintenance.ts";
import { createStoryService } from "../../src/server/stories/service.ts";
import { observeWait } from "../admin-drafts/test-support.mjs";
import { transport, privateHeaders, assetDto } from "./upload-http-tests.mjs";

const v2 = assetId => ({ version: 2, blocks: [
  { type: "paragraph", text: "Synthetic lifecycle fixture; no personal content." },
  { type: "image", assetId, alt: "Synthetic lifecycle image" },
] });

/** Uses only the runner's random database, synthetic administrator and private
 * directory. Crash interception exists solely in that database as a disposable
 * trigger, never as a production server test hook. */
export async function runMediaLifecycleHttpTests({ connectionString, maintenanceUrl, runtimeUrl, runtimeRole,
  origin, ca, storageRoot, restartServer }) {
  const target = new URL(connectionString);
  assert.match(target.pathname, /^\/mq_test_admin_[a-f0-9]{32}$/);
  assert.equal(target.username, "mq_test");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.match(runtimeRole, /^mq_admin_rt_[a-f0-9]{32}$/);
  for (const candidate of [maintenanceUrl, runtimeUrl]) {
    const url = new URL(candidate); assert.equal(url.host, target.host); assert.equal(url.pathname, target.pathname);
  }
  const owner = new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  const maintenance = createAuthDatabaseClient(maintenanceUrl), trusted = createAuthDatabaseClient(connectionString);
  const stories = createStoryService(trusted), suffix = randomBytes(5).toString("hex");
  const username = `delete_${suffix}`, password = `MqDelete!${randomBytes(24).toString("base64url")}`;
  const regular = { username: `reader_${suffix}`, password: `MqReader!${randomBytes(24).toString("base64url")}` };
  const secrets = new Set([password, regular.password, storageRoot]);
  const { request } = transport(origin, secrets, ca), ordinaryJar = {};
  let jar = {}, grant, passed = 0, stage = "initialize lifecycle HTTP", publicStory, reusedStory, publicAsset, privateAsset;
  const png = await sharp({ create: { width: 72, height: 48, channels: 3, background: "#6285aa" } }).png().toBuffer();
  const path = id => `/api/admin/media/${id}`;
  const contentPath = id => `${path(id)}/content`;
  const remove = (id, options = {}) => request(path(id), {
    method: "DELETE", jar, headers: { "x-mq-confirm-delete": id }, ...options,
  });
  const state = async id => (await owner.query("SELECT state,storage_key FROM media_asset WHERE id=$1", [id])).rows[0];
  async function collectSecrets() {
    const rows = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT "tokenCiphertext" AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL UNION ALL SELECT storage_key::text AS value FROM media_asset')).rows;
    rows.forEach(row => secrets.add(row.value));
  }
  async function run(name, action) {
    stage = name; await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
    await action(); await collectSecrets(); passed++; console.log(`PASS media lifecycle HTTP: ${name}`);
  }
  async function login() {
    const next = {};
    const response = await request("/api/auth/sign-in/username", { method: "POST", body: { username, password }, jar: next });
    assert.equal(response.status, 200); assert.ok(next.cookie); await collectSecrets(); return next;
  }
  async function upload() {
    const id = randomUUID();
    const response = await request("/api/admin/media", { method: "POST", jar, bytes: png, mime: "image/png", id });
    assert.equal(response.status, 201); assetDto(response.data.asset); await collectSecrets(); return id;
  }
  async function bytes(id, variant = "display") {
    const record = await state(id); return readFile(join(storageRoot, record.storage_key, `${variant}.webp`));
  }
  async function createStory(assetId, kind = "STAR") {
    return stories.createDraft({ kind, slug: `lifecycle-${randomUUID()}`, title: "Synthetic lifecycle story", content: v2(assetId) });
  }
  async function publish(story, slot) {
    if (slot) story = await stories.reserveSlot({ storyId: story.id, expectedVersion: story.version, slotId: slot });
    return stories.publish({ storyId: story.id, expectedVersion: story.version });
  }
  async function publicRead(story, assetId, expected = 200, method = "GET") {
    const response = await request(`/api/stories/${story.id}/media/${assetId}`, { method, headers: { "if-none-match": "*" } });
    assert.equal(response.status, expected); privateHeaders(response);
    if (expected === 200 && method === "GET") assert.deepEqual(response.bytes, await bytes(assetId));
    if (method === "HEAD") assert.equal(response.bytes.length, 0);
  }
  try {
    await run("guest, ordinary account and forged role cannot delete private media", async () => {
      grant = await initializeAdmin(maintenance, { username, password }); jar = await login();
      privateAsset = await upload(); publicAsset = await upload();
      assert.equal((await request("/api/auth/sign-up/email", { method: "POST", body: regular, jar: ordinaryJar })).status, 200);
      for (const candidate of [null, ordinaryJar]) {
        const response = await remove(privateAsset, { jar: candidate, headers: { "x-mq-confirm-delete": privateAsset, "x-role": "admin" } });
        assert.equal(response.status, candidate ? 403 : 401); privateHeaders(response);
      }
      assert.equal((await state(privateAsset)).state, "READY");
    });
    await run("explicit matching confirmation, exact Origin and path-free request are mandatory", async () => {
      for (const options of [{ headers: {} }, { headers: { "x-mq-confirm-delete": randomUUID() } }]) {
        const response = await remove(privateAsset, options); assert.equal(response.status, 400); privateHeaders(response);
      }
      for (const options of [{ requestOrigin: "https://attacker.invalid" }, { requestOrigin: null }, { headers: { "x-mq-confirm-delete": privateAsset, "sec-fetch-site": "cross-site" } }]) {
        assert.equal((await remove(privateAsset, options)).status, 403);
      }
      assert.equal((await remove(privateAsset, { body: { storageKey: randomUUID() } })).status, 400);
      assert.equal((await request(`${path(privateAsset)}?path=..`, { method: "DELETE", jar, headers: { "x-mq-confirm-delete": privateAsset } })).status, 400);
      assert.equal((await remove("not-an-asset")).status, 400);
      assert.equal((await remove(randomUUID())).status, 404);
      assert.equal((await state(privateAsset)).state, "READY");
    });
    await run("confirmed unreferenced deletion removes only its pair and is idempotent", async () => {
      const id = await upload(), record = await state(id), neighbor = await bytes(privateAsset);
      const response = await remove(id); assert.equal(response.status, 200); privateHeaders(response);
      assetDto(response.data.asset); assert.equal(response.data.asset.id, id); assert.equal(response.data.asset.state, "DELETED");
      assert.equal((await state(id)).state, "DELETED"); assert.ok(!(await readdir(storageRoot)).includes(record.storage_key));
      assert.deepEqual(await bytes(privateAsset), neighbor);
      assert.equal((await remove(id)).status, 200);
      for (const method of ["GET", "HEAD"]) {
        const denied = await request(contentPath(id), { jar, method }); assert.equal(denied.status, 404); privateHeaders(denied);
      }
    });
    await run("historical references survive new drafts, publication changes and cross-story reuse", async () => {
      const slots = (await owner.query("SELECT id FROM star_slot ORDER BY id")).rows;
      publicStory = await publish(await createStory(publicAsset), slots[0].id);
      reusedStory = await publish(await createStory(publicAsset), slots[1].id);
      publicStory = await stories.saveDraft({ storyId: publicStory.id, expectedVersion: publicStory.version,
        title: "Synthetic new draft without image", content: { version: 2, blocks: [{ type: "paragraph", text: "Current draft has no managed image." }] } });
      const denied = await remove(publicAsset); assert.equal(denied.status, 409); assert.equal(denied.data.code, "MEDIA_REFERENCED");
      await publicRead(publicStory, publicAsset); await publicRead(reusedStory, publicAsset, 200, "HEAD");
      publicStory = await stories.publish({ storyId: publicStory.id, expectedVersion: publicStory.version });
      publicStory = await stories.withdraw({ storyId: publicStory.id, expectedVersion: publicStory.version });
      assert.equal((await remove(publicAsset)).status, 409);
      await publicRead(publicStory, publicAsset, 404); await publicRead(reusedStory, publicAsset);
      assert.equal((await state(publicAsset)).state, "READY");
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_revision_asset WHERE asset_id=$1", [publicAsset])).rows[0].n, 2);
    });
    await run("unknown files stop deletion before any unlink and an explicit retry finishes safely", async () => {
      const id = await upload(), record = await state(id), original = await bytes(id);
      const unknown = join(storageRoot, record.storage_key, "operator-note.txt");
      await writeFile(unknown, "synthetic unknown file; must not be deleted", { flag: "wx", mode: 0o600 });
      const response = await remove(id); assert.equal(response.status, 503); privateHeaders(response);
      assert.equal((await state(id)).state, "DELETING"); assert.deepEqual(await bytes(id), original);
      assert.match(await readFile(unknown, "utf8"), /must not be deleted/);
      assert.equal((await request(contentPath(id), { jar })).status, 404);
      await unlink(unknown); // Only the test-created sentinel is removed by the test.
      assert.equal((await remove(id)).status, 200); assert.equal((await state(id)).state, "DELETED");
      assert.ok(!(await readdir(storageRoot)).includes(record.storage_key));
    });
    await run("database write denial cannot delete any READY file", async () => {
      const id = await upload(), original = await bytes(id);
      try {
        await owner.query(`REVOKE UPDATE(state) ON media_asset FROM "${runtimeRole}"`);
        assert.equal((await remove(id)).status, 503); assert.equal((await state(id)).state, "READY");
        assert.deepEqual(await bytes(id), original);
      } finally { await owner.query(`GRANT UPDATE(state) ON media_asset TO "${runtimeRole}"`); }
      assert.equal((await remove(id)).status, 200);
    });
    await run("real process crash after file removal leaves durable DELETING for retry", async () => {
      assert.equal(typeof restartServer, "function");
      const id = await upload(), record = await state(id), barrier = await owner.connect();
      let requestResult;
      try {
        await owner.query(`CREATE FUNCTION public.mq_test_hold_delete() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.id='${id}'::uuid AND NEW.state='DELETED' THEN PERFORM pg_advisory_xact_lock(5067094, 1); END IF;
          RETURN NEW; END $$;
          CREATE TRIGGER mq_test_hold_delete BEFORE UPDATE ON media_asset FOR EACH ROW EXECUTE FUNCTION public.mq_test_hold_delete()`);
        await barrier.query("SELECT pg_advisory_lock(5067094,1)");
        requestResult = remove(id).then(response => response, () => null);
        await observeWait(owner, runtimeRole);
        assert.equal((await state(id)).state, "DELETING");
        assert.ok(!(await readdir(storageRoot)).includes(record.storage_key));
        await restartServer(); await requestResult;
        await barrier.query("SELECT pg_advisory_unlock(5067094,1)");
        assert.equal((await state(id)).state, "DELETING");
      } finally {
        await barrier.query("SELECT pg_advisory_unlock_all()"); barrier.release();
        await owner.query("DROP TRIGGER IF EXISTS mq_test_hold_delete ON media_asset; DROP FUNCTION IF EXISTS public.mq_test_hold_delete()");
        if (requestResult) await requestResult;
      }
      assert.equal((await remove(id)).status, 200); assert.equal((await state(id)).state, "DELETED");
      assert.equal((await remove(id)).status, 200); await publicRead(reusedStory, publicAsset);
    });
    await run("revoked grant, expired sessions and copied logout cookies cannot delete", async () => {
      const copied = { ...jar };
      grant = await revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      assert.equal((await remove(privateAsset, { jar: copied })).status, 401);
      jar = await login(); assert.equal((await remove(privateAsset)).status, 403);
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version }); jar = await login();
      await sessionFixture.expire(owner, grant.userId);
      assert.equal((await remove(privateAsset)).status, 401); jar = await login();
      const loggedOut = { ...jar };
      assert.equal((await request("/api/auth/sign-out", { method: "POST", body: {}, jar })).status, 200);
      assert.equal((await remove(privateAsset, { jar: loggedOut })).status, 401); jar = await login();
      assert.equal((await state(privateAsset)).state, "READY"); await publicRead(reusedStory, publicAsset);
    });
    await run("PENDING and FAILED deletion requires offline recovery, never racing live writers", async () => {
      const id = randomUUID(); await owner.query("INSERT INTO media_asset(id) VALUES($1)", [id]);
      assert.equal((await remove(id)).status, 409);
      await owner.query("UPDATE media_asset SET state='FAILED' WHERE id=$1", [id]);
      const response = await remove(id); assert.equal(response.status, 409); assert.equal(response.data.code, "MEDIA_UPLOAD_ACTIVE");
      assert.equal((await state(id)).state, "FAILED");
    });
    await run("v1 and v2 public content, drafts and revisions are unchanged by rejected deletions", async () => {
      const legacy = await stories.createDraft({ kind: "CAMPFIRE", slug: `legacy-${randomUUID()}`, title: "Synthetic legacy story",
        content: { version: 1, blocks: [{ type: "image", src: "/scene/night-sky.webp", alt: "Synthetic legacy image" }] } });
      const published = await publish(legacy);
      for (const story of [published, reusedStory]) {
        const response = await request(`/api/stories/${story.id}`); assert.equal(response.status, 200); privateHeaders(response);
        assert.equal((await request(`/stories/${story.slug}`)).status, 200);
      }
      const hidden = await createStory(privateAsset);
      await publicRead(hidden, privateAsset, 404); await publicRead(hidden, privateAsset, 404, "HEAD");
      assert.equal((await request(`/api/stories/${hidden.id}`)).status, 404);
      const before = (await owner.query("SELECT (SELECT count(*) FROM story_revision)::int AS revisions,(SELECT count(*) FROM story_revision_asset)::int AS refs")).rows[0];
      assert.equal((await remove(privateAsset)).status, 409);
      const after = (await owner.query("SELECT (SELECT count(*) FROM story_revision)::int AS revisions,(SELECT count(*) FROM story_revision_asset)::int AS refs")).rows[0];
      assert.deepEqual(after, before); assert.equal((await request(contentPath(privateAsset), { jar })).status, 200);
    });
  } catch (error) {
    const safe = new Error("MEDIA_LIFECYCLE_HTTP_FAILED"); safe.stage = stage;
    safe.code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR"; throw safe;
  } finally { await Promise.allSettled([owner.end(), maintenance.$disconnect(), trusted.$disconnect()]); }
  return { passed, total: 10, secrets: [...secrets], username, password,
    publicStoryId: reusedStory.id, publicAssetId: publicAsset, privateAssetId: privateAsset };
}
