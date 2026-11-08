import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { URL } from "node:url";
import pg from "pg";
import { assertTemporaryTarget, observeWait } from "../admin-drafts/test-support.mjs";
import { initializePublishingKey } from "./privileges.mjs";
import { sessionFixture } from "../auth/session-fixture.mjs";

export async function runPublishingDatabaseTests({ connectionString, runtimeUrl, maintenanceUrl, publicationOwnerRole, key }) {
  const target = assertTemporaryTarget(connectionString);
  for (const url of [runtimeUrl, maintenanceUrl]) {
    const parsed = assertTemporaryTarget(url);
    assert.equal(parsed.host, target.host); assert.equal(parsed.pathname, target.pathname);
  }
  const owner = new pg.Pool({ connectionString, max: 5 });
  const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 5 });
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl, max: 2 });
  const adminId = randomUUID(), ordinaryId = randomUUID();
  let adminSession, ordinarySession, passed = 0, stage = "fixture";
  const check = async (name, run) => { stage = name; await run(); passed++; console.log(`PASS publishing database: ${name}`); };
  const reject = async (promise, expected) => {
    const code = await promise.then(() => "SUCCESS", error => error?.code);
    if (code !== expected) throw new Error(`Expected ${expected}; observed ${/^[A-Z0-9]{5}$/.test(code ?? "") ? code : "unknown"}`);
  };
  async function transaction(pool, run) {
    const tx = await pool.connect();
    try { await tx.query("BEGIN"); const value = await run(tx); await tx.query("COMMIT"); return value; }
    catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }
  async function session(userId, expired = false) {
    const id = randomUUID();
    await sessionFixture.insert(runtime, { id, userId, expiresAt: new Date(Date.now() + (expired ? -1 : 1) * 3_600_000) });
    return id;
  }
  async function create(kind = "STAR", content = { version: 1, blocks: [{ type: "paragraph", text: "Synthetic publication" }] }) {
    const id = randomUUID(), revision = randomUUID();
    await transaction(runtime, async tx => {
      await tx.query("INSERT INTO public.story(id,slug,kind,draft_revision_id) VALUES($1,$2,$3,$4)", [id, `synthetic-${id}`, kind, revision]);
      await tx.query("INSERT INTO public.story_revision(id,story_id,title,content) VALUES($1,$2,'Synthetic publication',$3)", [revision, id, content]);
    });
    return id;
  }
  const read = async id => (await owner.query("SELECT * FROM public.story WHERE id=$1", [id])).rows[0];
  async function proof(tx, id, action, { version, revision, slot, sessionId = adminSession, userId = adminId } = {}) {
    const context = (await tx.query("SELECT current_database() AS db,session_user AS actor,pg_current_xact_id()::text AS xid")).rows[0];
    const story = await read(id);
    const parts = ["mq-publish-v1", context.db, context.actor, context.xid, sessionId, userId, action, id,
      String(version ?? story.version), revision ?? (action === "slot" ? "" : action === "publish" ? story.draft_revision_id : story.published_revision_id ?? ""),
      slot ?? (action === "slot" ? "" : story.slot_id ?? "")];
    const payload = JSON.stringify(parts);
    return { parts, payload, signature: createHmac("sha256", Buffer.from(key, "hex")).update(payload).digest() };
  }
  const invoke = (tx, p) => tx.query("SELECT public.mq_apply_story_publication($1,$2) AS id", [p.payload, p.signature]);
  const action = (id, name, options) => transaction(runtime, async tx => invoke(tx, await proof(tx, id, name, options)));
  async function save(id) {
    const revision = randomUUID();
    await transaction(runtime, async tx => {
      await tx.query("INSERT INTO public.story_revision(id,story_id,title,content) VALUES($1,$2,'Synthetic new draft',$3)",
        [revision, id, { version: 1, blocks: [{ type: "paragraph", text: "Synthetic later private draft" }] }]);
      await tx.query("UPDATE public.story SET draft_revision_id=$2,version=version+1 WHERE id=$1", [id, revision]);
    });
    return revision;
  }
  try {
    for (const id of [adminId, ordinaryId]) {
      const username = `publish_${id.replaceAll("-", "").slice(0, 14)}`;
      await owner.query(`INSERT INTO public."User"(id,name,email,"updatedAt",username)
        VALUES($1,$2,$3,now(),$2)`, [id, username, `${randomUUID()}@accounts.invalid`]);
    }
    await owner.query('INSERT INTO public."AdminGrant"("userId") VALUES($1)', [adminId]);
    adminSession = await session(adminId); ordinarySession = await session(ordinaryId);
    const draft = await create();
    await check("runtime cannot change publication columns, keys or function ownership", async () => {
      for (const column of ["state", "published_revision_id", "slot_id"]) {
        await reject(runtime.query(`UPDATE public.story SET ${column}=${column} WHERE false`), "42501");
      }
      await reject(runtime.query("SELECT secret FROM mq_publish_private.signing_key"), "42501");
      await reject(maintenance.query("SELECT secret FROM mq_publish_private.signing_key"), "42501");
      await reject(runtime.query(`SET ROLE "${publicationOwnerRole}"`), "42501");
      await reject(runtime.query("ALTER FUNCTION public.mq_apply_story_publication(text,bytea) SECURITY INVOKER"), "42501");
      for (const sql of ['SELECT * FROM public."Session"', 'UPDATE mq_publish_private.signing_key SET secret=secret',
        'UPDATE public.story SET draft_revision_id=draft_revision_id WHERE false', 'INSERT INTO public."AdminGrant"("userId") VALUES(\'synthetic\')']) {
        await reject(transaction(owner, async tx => { await tx.query(`SET LOCAL ROLE "${publicationOwnerRole}"`); return tx.query(sql); }), "42501");
      }
    });
    await check("missing database key fails closed and duplicate initialization refuses overwrite", async () => {
      await owner.query("DELETE FROM mq_publish_private.signing_key");
      await reject(action(draft, "slot"), "P7102");
      await initializePublishingKey(owner, { expectedDatabase: target.pathname.slice(1), key });
      await assert.rejects(initializePublishingKey(owner, { expectedDatabase: target.pathname.slice(1), key }), /INITIALIZATION_REJECTED/);
    });
    await check("forged proof and each signed parameter substitution are rejected", async () => {
      await reject(transaction(runtime, async tx => {
        const p = await proof(tx, draft, "slot"); p.signature.fill(0); return invoke(tx, p);
      }), "P7101");
      for (let index = 0; index < 11; index++) {
        await reject(transaction(runtime, async tx => {
          const p = await proof(tx, draft, "slot"); p.parts[index] += "changed"; p.payload = JSON.stringify(p.parts); return invoke(tx, p);
        }), "P7101");
      }
      assert.equal((await read(draft)).version, 0);
    });
    await check("cross-transaction and cross-identity replay fail", async () => {
      const p = await transaction(runtime, tx => proof(tx, draft, "slot"));
      await reject(transaction(runtime, tx => invoke(tx, p)), "P7101");
      await reject(transaction(runtime, async tx => {
        const another = await proof(tx, draft, "slot"); another.parts[2] = "other_runtime";
        another.payload = JSON.stringify(another.parts); another.signature = createHmac("sha256", Buffer.from(key, "hex")).update(another.payload).digest();
        return invoke(tx, another);
      }), "P7101");
    });
    await check("ordinary, missing and expired sessions fail even with otherwise valid signatures", async () => {
      await reject(action(draft, "slot", { sessionId: ordinarySession, userId: ordinaryId }), "P7101");
      await reject(action(draft, "slot", { sessionId: randomUUID() }), "P7101");
      await reject(action(draft, "slot", { sessionId: await session(adminId, true) }), "P7101");
    });
    await check("database independently rejects no-slot publish, invalid actions and cross-story revisions", async () => {
      await reject(action(draft, "publish"), "P7105");
      await reject(action(draft, "anything"), "P7100");
      await reject(action(draft, "slot", { slot: "missing-slot" }), "P7100");
      await action(draft, "slot", { slot: "star-1" });
      const other = await create();
      await reject(action(draft, "publish", { revision: (await read(other)).draft_revision_id }), "P7103");
    });
    await check("first publish, explicit update and withdrawal/restoration preserve the selected public snapshot", async () => {
      await action(draft, "publish");
      const original = (await read(draft)).published_revision_id;
      const updated = await save(draft);
      assert.equal((await read(draft)).published_revision_id, original);
      await action(draft, "publish");
      assert.equal((await read(draft)).published_revision_id, updated);
      await action(draft, "withdraw");
      const privateRevision = await save(draft);
      await reject(action(draft, "publish"), "P7105");
      await action(draft, "restore");
      const restored = await read(draft);
      assert.equal(restored.published_revision_id, updated);
      assert.equal(restored.draft_revision_id, privateRevision);
      await reject(action(draft, "slot", { slot: "star-3" }), "P7105");
    });
    await check("concurrent publication has one CAS winner; stale operation leaves no mutation", async () => {
      const current = await read(draft);
      const outcomes = await Promise.allSettled([action(draft, "publish", { version: current.version }), action(draft, "publish", { version: current.version })]);
      assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
      assert.equal(outcomes.find(x => x.status === "rejected").reason.code, "P7103");
      assert.equal((await read(draft)).version, current.version + 1);
      await reject(action(draft, "publish"), "P7105");
    });
    await check("concurrent slot selection has one unique-index winner", async () => {
      const a = await create(), b = await create();
      const outcomes = await Promise.allSettled([action(a, "slot", { slot: "star-2" }), action(b, "slot", { slot: "star-2" })]);
      assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
      assert.equal(outcomes.find(x => x.status === "rejected").reason.code, "23505");
      const states = await Promise.all([read(a), read(b)]);
      assert.deepEqual(states.map(x => x.version).sort(), [0, 1]);
    });
    await check("same-transaction replay and later errors roll back the earlier CAS", async () => {
      const fresh = await create();
      await reject(transaction(runtime, async tx => {
        const p = await proof(tx, fresh, "slot"); await invoke(tx, p); await invoke(tx, p);
      }), "P7103");
      assert.equal((await read(fresh)).version, 0);
      await assert.rejects(transaction(runtime, async tx => {
        await invoke(tx, await proof(tx, fresh, "slot")); throw new Error("synthetic rollback");
      }), /synthetic rollback/);
      assert.equal((await read(fresh)).version, 0);
    });
    await check("campfire publishes without a slot and remains globally unique", async () => {
      const campfire = await create("CAMPFIRE"); await action(campfire, "publish");
      assert.equal((await read(campfire)).slot_id, null);
      await reject(create("CAMPFIRE"), "23505");
    });
    await check("v2 publication retains exact READY references and pending media cannot enter a revision", async () => {
      const asset = randomUUID(), pending = randomUUID();
      await runtime.query("INSERT INTO public.media_asset(id) VALUES($1),($2)", [asset, pending]);
      await runtime.query(`UPDATE public.media_asset SET state='READY',
        display_mime_type='image/webp',display_width=1,display_height=1,display_bytes=32,display_sha256=$2,
        thumbnail_mime_type='image/webp',thumbnail_width=1,thumbnail_height=1,thumbnail_bytes=32,thumbnail_sha256=$2 WHERE id=$1`, [asset, "a".repeat(64)]);
      const content = id => ({ version: 2, blocks: [{ type: "paragraph", text: "Synthetic managed image" }, { type: "image", assetId: id, alt: "Synthetic" }] });
      await reject(create("STAR", content(pending)), "23503");
      const storyId = await create("STAR", content(asset));
      await owner.query("INSERT INTO public.star_slot(id,scene_key) VALUES('test-publish-assets','test-publish-assets')");
      await action(storyId, "slot", { slot: "test-publish-assets" });
      await action(storyId, "publish");
      const story = await read(storyId);
      const references = (await runtime.query("SELECT asset_id FROM public.story_revision_asset WHERE revision_id=$1", [story.published_revision_id])).rows;
      assert.deepEqual(references, [{ asset_id: asset }]);
      await reject(runtime.query("UPDATE public.media_asset SET state='DELETING' WHERE id=$1", [asset]), "23001");
    });
    await check("publication holds authorization locks through commit; revocation then denies new work", async () => {
      const fresh = await create(), tx = await runtime.connect(), revoker = await maintenance.connect();
      let pending;
      try {
        await tx.query("BEGIN"); await invoke(tx, await proof(tx, fresh, "slot"));
        const pid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        pending = revoker.query('UPDATE public."AdminGrant" SET "revokedAt"=now(),version=version+1 WHERE id=1');
        await observeWait(owner, decodeURIComponent(new URL(maintenanceUrl).username), `pid=${Number(pid)}`);
        await tx.query("COMMIT"); await pending;
        assert.equal((await read(fresh)).version, 1);
        await reject(action(fresh, "slot"), "P7101");
        const forgedAfterRevoke = await session(adminId);
        await reject(action(fresh, "slot", { sessionId: forgedAfterRevoke }), "P7101");
      } finally { await tx.query("ROLLBACK"); await pending?.catch(() => {}); tx.release(); revoker.release(); }
    });
    return { passed, total: 13 };
  } catch (error) {
    const category = /^[A-Z0-9]{5}$/.test(error?.code ?? "") ? error.code : "ASSERTION";
    // Original driver errors can contain a row or proof; expose fixed test scope only.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Publishing database failed at ${stage} (${category}; details withheld)`);
  } finally { await Promise.all([owner.end(), runtime.end(), maintenance.end()]); }
}
