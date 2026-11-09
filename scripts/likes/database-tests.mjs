import { sessionFixture } from "../auth/session-fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { createStoryLikeOperations } from "../../src/server/likes/service.ts";
import { createStoryService } from "../../src/server/stories/service.ts";
import { assertTemporaryTarget, createLikeFixtures, observeWait } from "./test-support.mjs";

export async function runLikeDatabaseTests({ connectionString, runtimeUrl, runtimeRole }) {
  assertTemporaryTarget(connectionString); assertTemporaryTarget(runtimeUrl);
  const owner = new pg.Pool({ connectionString, max: 3 }), restricted = new pg.Pool({ connectionString: runtimeUrl, max: 2 });
  const trusted = createAuthDatabaseClient(connectionString), runtime = createAuthDatabaseClient(runtimeUrl);
  const lifecycle = createStoryService(trusted);
  let passed = 0, stage = "fixtures";
  const check = async (name, action) => { stage = name; await action(); passed++; console.log(`PASS likes PostgreSQL: ${name}`); };
  const set = (id, principal, liked) => runtime.$transaction(tx => createStoryLikeOperations(tx).set(id, principal, liked));
  const read = (id, principal = null) => runtime.$transaction(tx => createStoryLikeOperations(tx).read(id, principal));
  try {
    const fixtures = await createLikeFixtures(trusted), id = fixtures.first.id;
    const principals = [];
    for (let index = 0; index < 2; index++) {
      const userId = randomUUID(), sessionId = randomUUID();
      await trusted.user.create({ data: { id: userId, name: "Synthetic reader", username: `db_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        email: `${userId}@accounts.invalid` } });
      await trusted.session.create({ data: sessionFixture.row({ id: sessionId, userId, expiresAt: new Date(Date.now() + 3600_000) }) });
      principals.push({ userId, sessionId });
    }
    const [alice, bob] = principals;
    await check("effective runtime rights add likes without granting publication, credentials or DDL", async () => {
      assert.equal((await restricted.query("SELECT current_user AS role")).rows[0].role, runtimeRole);
      assert.equal((await restricted.query("SELECT has_table_privilege(current_user,'public.story_like','SELECT') AS allowed")).rows[0].allowed, true);
      for (const statement of ["UPDATE story_like SET created_at=created_at WHERE false", "TRUNCATE story_like",
        "UPDATE story SET state=state WHERE false", 'UPDATE "Session" SET "expiresAt"="expiresAt" WHERE false',
        'UPDATE "User" SET username=username WHERE false', 'INSERT INTO "AdminGrant" DEFAULT VALUES', "CREATE TABLE public.likes_denied(id int)"]) {
        await assert.rejects(restricted.query(statement), { code: "42501" });
      }
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.mq_lock_story_like_access(text,text,uuid)'::regprocedure AND a.grantee=0")).rows[0].n, 0);
    });
    await check("composite primary key and both foreign keys reject duplicate or orphan likes", async () => {
      await owner.query("INSERT INTO story_like(user_id,story_id) VALUES($1,$2)", [alice.userId, id]);
      await assert.rejects(owner.query("INSERT INTO story_like(user_id,story_id) VALUES($1,$2)", [alice.userId, id]), { code: "23505" });
      await assert.rejects(owner.query("INSERT INTO story_like(user_id,story_id) VALUES($1,$2)", [randomUUID(), id]), { code: "23503" });
      await assert.rejects(owner.query("INSERT INTO story_like(user_id,story_id) VALUES($1,$2)", [alice.userId, randomUUID()]), { code: "23503" });
      await owner.query("DELETE FROM story_like WHERE user_id=$1 AND story_id=$2", [alice.userId, id]);
    });
    await check("real concurrent set requests count one like per account and deletes are idempotent", async () => {
      const repeated = await Promise.all(Array.from({ length: 6 }, () => set(id, alice, true)));
      repeated.forEach(value => assert.deepEqual(value, { count: 1, liked: true }));
      assert.deepEqual(await set(id, bob, true), { count: 2, liked: true });
      assert.deepEqual(await read(id), { count: 2, liked: false });
      const removed = await Promise.all(Array.from({ length: 6 }, () => set(id, alice, false)));
      removed.forEach(value => assert.deepEqual(value, { count: 1, liked: false }));
      assert.deepEqual(await read(id, bob), { count: 1, liked: true });
    });
    await check("transaction rollback leaves no like and another story has an independent count", async () => {
      await assert.rejects(runtime.$transaction(async tx => {
        await createStoryLikeOperations(tx).set(id, alice, true); throw new Error("SYNTHETIC_LIKE_ROLLBACK");
      }), /SYNTHETIC_LIKE_ROLLBACK/);
      assert.deepEqual(await read(id, alice), { count: 1, liked: false });
      assert.deepEqual(await set(fixtures.second.id, alice, true), { count: 1, liked: true });
      assert.deepEqual(await read(id, alice), { count: 1, liked: false });
    });
    await check("unknown, draft and withdrawn stories are equally unavailable", async () => {
      for (const storyId of [randomUUID(), fixtures.draft.id, fixtures.withdrawn.id]) {
        await assert.rejects(read(storyId), { code: "LIKES_NOT_FOUND" });
        for (const liked of [true, false]) await assert.rejects(set(storyId, alice, liked), { code: "LIKES_NOT_FOUND" });
      }
    });
    await check("withdrawal winning the row lock prevents a queued like and restore retains existing likes", async () => {
      const gate = await owner.connect(); let pending;
      try {
        await gate.query("BEGIN"); await gate.query("SELECT id FROM story WHERE id=$1 FOR UPDATE", [id]);
        pending = set(id, alice, true); const rejected = assert.rejects(pending, { code: "LIKES_NOT_FOUND" });
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')");
        await gate.query("UPDATE story SET state='WITHDRAWN',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1", [id]);
        await gate.query("COMMIT"); await rejected;
      } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => {}); }
      const story = await trusted.story.findUniqueOrThrow({ where: { id } });
      await lifecycle.restore({ storyId: id, expectedVersion: story.version });
      assert.deepEqual(await read(id, bob), { count: 1, liked: true });
    });
    await check("session deletion winning its row lock rejects a queued write and stale reads are anonymous", async () => {
      const gate = await owner.connect(); let pending;
      try {
        await gate.query("BEGIN"); await gate.query('SELECT id FROM "Session" WHERE id=$1 FOR UPDATE', [alice.sessionId]);
        pending = set(id, alice, true); const rejected = assert.rejects(pending, { code: "LIKES_UNAUTHENTICATED" });
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')");
        await gate.query('DELETE FROM "Session" WHERE id=$1', [alice.sessionId]); await gate.query("COMMIT"); await rejected;
      } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => {}); }
      assert.deepEqual(await read(id, alice), { count: 1, liked: false });
      assert.deepEqual(await read(fixtures.second.id, alice), { count: 1, liked: false });
    });
    return { passed, total: 7 };
  } catch (error) { error.likesStage = stage; throw error; }
  finally { await Promise.allSettled([owner.end(), restricted.end(), trusted.$disconnect(), runtime.$disconnect()]); }
}
