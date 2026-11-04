import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { beginMediaDeletion, finishMediaDeletion } from "../../src/server/media/lifecycle.ts";

const content = assetId => ({ version: 2, blocks: [{ type: "image", assetId, alt: "Synthetic retained media" }] });

/** Genuine PostgreSQL ordering tests. The production transaction operations run
 * under the restricted runtime role; owner access only arranges synthetic rows
 * and observes pg_locks. HTTP authorization is tested separately. */
export async function runMediaLifecycleDatabaseTests({ connectionString, runtimeUrl }) {
  const target = new URL(connectionString), application = new URL(runtimeUrl);
  assert.match(target.pathname, /^\/mq_test_admin_[a-f0-9]{32}$/);
  assert.equal(target.username, "mq_test");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  for (const field of ["protocol", "host", "pathname"]) assert.equal(application[field], target[field]);
  assert.match(application.username, /^mq_admin_rt_[a-f0-9]{32}$/);
  const owner = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  const runtime = createAuthDatabaseClient(runtimeUrl);
  let passed = 0, stage = "initialization";
  async function run(name, action) {
    stage = name; await action(); passed++; console.log(`PASS media lifecycle database: ${name}`);
  }
  async function ready() {
    const id = randomUUID();
    await owner.query("INSERT INTO media_asset(id) VALUES($1)", [id]);
    await owner.query(`UPDATE media_asset SET state='READY',display_mime_type='image/webp',display_width=20,display_height=10,
      display_bytes=40,display_sha256=repeat('a',64),thumbnail_mime_type='image/webp',thumbnail_width=20,thumbnail_height=10,
      thumbnail_bytes=40,thumbnail_sha256=repeat('b',64) WHERE id=$1`, [id]);
    return id;
  }
  async function insertStory(connection, assetId) {
    const id = randomUUID(), revision = randomUUID();
    await connection.query("INSERT INTO story(id,slug,kind,draft_revision_id) VALUES($1,$2,'STAR',$3)", [id, `synthetic-${id}`, revision]);
    await connection.query("INSERT INTO story_revision(id,story_id,title,content) VALUES($1,$2,$3,$4::jsonb)",
      [revision, id, "Synthetic lifecycle story", JSON.stringify(content(assetId))]);
    return { id, revision };
  }
  async function createStory(assetId) {
    const connection = await owner.connect();
    try {
      await connection.query("BEGIN"); const result = await insertStory(connection, assetId);
      await connection.query("COMMIT"); return result;
    } catch (error) { await connection.query("ROLLBACK"); throw error; }
    finally { connection.release(); }
  }
  const begin = id => runtime.$transaction(tx => beginMediaDeletion(tx, id));
  const finish = id => runtime.$transaction(tx => finishMediaDeletion(tx, id));
  async function row(id) { return (await owner.query("SELECT state,storage_key FROM media_asset WHERE id=$1", [id])).rows[0]; }
  async function waitForLock(waiter, blocker) {
    for (let n = 0; n < 150; n++) {
      if (waiter() !== undefined && (await owner.query(`SELECT count(*)::int AS n FROM pg_locks
        WHERE pid=$1 AND NOT granted AND $2=ANY(pg_blocking_pids(pid))`, [waiter(), blocker])).rows[0].n > 0) return;
      await delay(10);
    }
    throw new Error("LIFECYCLE_LOCK_NOT_OBSERVED");
  }
  try {
    await run("unreferenced transitions are durable and repeated deletion retains identity", async () => {
      const id = await ready(), before = await row(id);
      assert.equal((await begin(id)).state, "DELETING");
      assert.equal((await begin(id)).state, "DELETING");
      assert.equal((await finish(id)).state, "DELETED");
      assert.equal((await begin(id)).state, "DELETED");
      assert.equal((await finish(id)).state, "DELETED");
      assert.equal((await row(id)).storage_key, before.storage_key);
    });
    await run("any historical revision and cross-story reuse prevent transition", async () => {
      const id = await ready(), first = await createStory(id);
      await createStory(id);
      const next = randomUUID(), connection = await owner.connect();
      try {
        await connection.query("BEGIN");
        await connection.query("INSERT INTO story_revision(id,story_id,title,content) VALUES($1,$2,$3,$4::jsonb)",
          [next, first.id, "New synthetic text only", JSON.stringify({ version: 2, blocks: [{ type: "paragraph", text: "Current draft no longer contains the historical image" }] })]);
        await connection.query("UPDATE story SET draft_revision_id=$1,version=version+1 WHERE id=$2", [next, first.id]);
        await connection.query("COMMIT");
      } finally { await connection.query("ROLLBACK"); connection.release(); }
      await assert.rejects(begin(id), error => error.status === 409);
      assert.equal((await row(id)).state, "READY");
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_revision_asset WHERE asset_id=$1", [id])).rows[0].n, 2);
      const state = await owner.query("UPDATE media_asset SET state='DELETING' WHERE id=$1", [id]).then(() => "SUCCESS", error => error.code);
      // ON UPDATE RESTRICT reports restrict_violation, whereas inserting a
      // reference to a missing READY key reports foreign_key_violation.
      assert.equal(state, "23001");
    });
    await run("failure after the state transition rolls the transaction back", async () => {
      const id = await ready();
      await assert.rejects(runtime.$transaction(async tx => {
        await beginMediaDeletion(tx, id); throw new Error("SYNTHETIC_TRANSACTION_FAILURE");
      }), /SYNTHETIC_TRANSACTION_FAILURE/);
      assert.equal((await row(id)).state, "READY");
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_revision_asset WHERE asset_id=$1", [id])).rows[0].n, 0);
    });
    await run("reference committed first blocks deletion without orphaning its revision", async () => {
      const id = await ready(), reference = await owner.connect();
      let waiting;
      try {
        await reference.query("BEGIN");
        const blocker = (await reference.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const story = await insertStory(reference, id);
        let waiter;
        waiting = runtime.$transaction(async tx => {
          waiter = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
          return beginMediaDeletion(tx, id);
        }).then(() => "SUCCESS", error => error.status);
        await waitForLock(() => waiter, blocker);
        await reference.query("COMMIT"); assert.equal(await waiting, 409);
        assert.equal((await row(id)).state, "READY");
        assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_revision_asset WHERE revision_id=$1", [story.revision])).rows[0].n, 1);
      } finally { await reference.query("ROLLBACK"); reference.release(); if (waiting) await waiting; }
    });
    await run("deletion committed first rejects and rolls back a concurrent new reference", async () => {
      const id = await ready(), reference = await owner.connect();
      let release, begun, blocker, waiting, newStory;
      const barrier = new Promise(resolve => { release = resolve; });
      const locked = new Promise(resolve => { begun = resolve; });
      const deletion = runtime.$transaction(async tx => {
        blocker = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
        await beginMediaDeletion(tx, id); begun(); await barrier;
      }, { timeout: 5000 });
      deletion.catch(() => {});
      try {
        await reference.query("BEGIN"); await reference.query("SET LOCAL statement_timeout='5s'");
        const waiter = (await reference.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await Promise.race([locked, deletion]);
        newStory = { id: randomUUID(), revision: randomUUID() };
        await reference.query("INSERT INTO story(id,slug,kind,draft_revision_id) VALUES($1,$2,'STAR',$3)",
          [newStory.id, `synthetic-${newStory.id}`, newStory.revision]);
        waiting = reference.query("INSERT INTO story_revision(id,story_id,title,content) VALUES($1,$2,$3,$4::jsonb)",
          [newStory.revision, newStory.id, "Concurrent synthetic revision", JSON.stringify(content(id))]).then(() => "SUCCESS", error => error.code);
        await waitForLock(() => waiter, blocker); release(); await deletion;
        assert.equal(await waiting, "23503"); await reference.query("ROLLBACK");
        assert.equal((await row(id)).state, "DELETING");
        assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_revision WHERE id=$1", [newStory.revision])).rows[0].n, 0);
        assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_revision_asset WHERE asset_id=$1", [id])).rows[0].n, 0);
      } finally { release(); await deletion.catch(() => {}); await reference.query("ROLLBACK"); reference.release(); if (waiting) await waiting; }
    });
    await run("online deletion refuses upload states and premature completion", async () => {
      const id = randomUUID(); await owner.query("INSERT INTO media_asset(id) VALUES($1)", [id]);
      await assert.rejects(begin(id), error => error.status === 409);
      await owner.query("UPDATE media_asset SET state='FAILED' WHERE id=$1", [id]);
      await assert.rejects(begin(id), error => error.status === 409);
      assert.equal((await row(id)).state, "FAILED");
      const fresh = await ready(); await assert.rejects(finish(fresh)); assert.equal((await row(fresh)).state, "READY");
    });
  } catch (error) {
    const safe = new Error("MEDIA_LIFECYCLE_DATABASE_FAILED"); safe.stage = stage;
    safe.code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR"; throw safe;
  } finally { await Promise.allSettled([owner.end(), runtime.$disconnect()]); }
  return { passed, total: 6 };
}
