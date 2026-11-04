import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { createDatabaseClient } from "../../src/lib/db/client.ts";
import { createPublicStoryReader } from "../../src/server/stories/public-service.ts";

export const MEDIA_MIGRATION = "202611030005_media_foundation";
const metadataColumns = ["display_mime_type", "display_width", "display_height", "display_bytes", "display_sha256",
  "thumbnail_mime_type", "thumbnail_width", "thumbnail_height", "thumbnail_bytes", "thumbnail_sha256"];
const paragraph = { type: "paragraph", text: "Synthetic media foundation paragraph" };
const v1 = { version: 1, blocks: [paragraph] };
const v2 = (...ids) => ({ version: 2, blocks: [paragraph, ...ids.map(assetId => ({ type: "image", assetId, alt: "Synthetic image" }))] });

/** Disposable integration fixture only, not production provisioning. The role
 * cannot publish, change permissions or write projection rows directly. */
export async function provisionMediaTestRuntime(pool, role, database) {
  assert.match(role, /^mq_media_rt_[a-f0-9]{32}$/);
  assert.match(database, /^mq_test_it_[a-f0-9]{32}$/);
  assert.equal((await pool.query("SELECT current_database() AS db")).rows[0].db, database);
  await pool.query(`REVOKE CREATE,TEMPORARY ON DATABASE "${database}" FROM PUBLIC`);
  await pool.query(`GRANT CONNECT ON DATABASE "${database}" TO "${role}"`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await pool.query(`GRANT SELECT ON story,story_revision,star_slot,media_asset,story_revision_asset TO "${role}"`);
  await pool.query(`GRANT INSERT (id,slug,kind,draft_revision_id) ON story TO "${role}"`);
  await pool.query(`GRANT UPDATE (draft_revision_id,version,updated_at) ON story TO "${role}"`);
  await pool.query(`GRANT INSERT (id,story_id,title,content) ON story_revision TO "${role}"`);
  await pool.query(`GRANT INSERT (id) ON media_asset TO "${role}"`);
  await pool.query(`GRANT UPDATE (state,${metadataColumns.join(",")}) ON media_asset TO "${role}"`);
}

export async function runMediaDatabaseTests({ connectionString, runtimeUrl }) {
  const target = new URL(connectionString), runtimeTarget = new URL(runtimeUrl);
  assert.match(target.pathname, /^\/mq_test_it_[a-f0-9]{32}$/);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname));
  for (const field of ["protocol", "hostname", "port", "pathname"]) assert.equal(runtimeTarget[field], target[field]);
  assert.match(decodeURIComponent(runtimeTarget.username), /^mq_media_rt_[a-f0-9]{32}$/);
  const owner = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 4, connectionTimeoutMillis: 5000 });
  const publicClient = createDatabaseClient(runtimeUrl);
  const publicReader = createPublicStoryReader(publicClient);
  let passed = 0, stage = "initialization";
  async function check(name, action) {
    stage = name;
    await action(); passed += 1; console.log(`PASS media database: ${name}`);
  }
  async function rejectCode(action, expected) {
    // The caught database object can contain a synthetic row or connection;
    // compare only SQLSTATE and never attach the original error to an assertion.
    const result = await action.then(() => "SUCCESS", error => error.code);
    if (result !== expected) {
      const failure = new Error("Unexpected SQLSTATE (raw details withheld)");
      failure.code = /^[A-Z0-9_]{1,30}$/.test(result ?? "") ? result : "ERROR";
      throw failure;
    }
  }
  async function transaction(pool, action) {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      const result = await action(connection);
      await connection.query("COMMIT"); return result;
    } catch (error) { await connection.query("ROLLBACK"); throw error; }
    finally { connection.release(); }
  }
  async function createStory(content = v1, pool = runtime) {
    const id = randomUUID(), revisionId = randomUUID(), slug = `media-${randomUUID()}`;
    await transaction(pool, async connection => {
      await connection.query("INSERT INTO story(id,slug,kind,draft_revision_id) VALUES ($1,$2,'STAR',$3)", [id, slug, revisionId]);
      await insertRevision(connection, id, revisionId, content);
    });
    return { id, revisionId, slug };
  }
  async function insertRevision(connection, storyId, revisionId, content) {
    await connection.query("INSERT INTO story_revision(id,story_id,title,content) VALUES ($1,$2,$3,$4::jsonb)",
      [revisionId, storyId, "Synthetic media story", JSON.stringify(content)]);
  }
  async function pendingAsset() {
    const id = randomUUID();
    await runtime.query("INSERT INTO media_asset(id) VALUES ($1)", [id]); return id;
  }
  async function readyAsset() {
    const id = await pendingAsset();
    await makeReady(id); return id;
  }
  async function makeReady(id) {
    await runtime.query(`UPDATE media_asset SET state='READY',display_mime_type='image/webp',display_width=800,display_height=600,display_bytes=1000,display_sha256=repeat('a',64),
      thumbnail_mime_type='image/webp',thumbnail_width=160,thumbnail_height=120,thumbnail_bytes=100,thumbnail_sha256=repeat('b',64) WHERE id=$1`, [id]);
  }
  async function refs(revisionId) {
    return (await runtime.query("SELECT asset_id,required_state FROM story_revision_asset WHERE revision_id=$1 ORDER BY asset_id", [revisionId])).rows;
  }
  async function waitForLock(waiter, blocker) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const waiting = (await owner.query(`SELECT count(*)::int AS n FROM pg_locks l
        WHERE l.pid=$1 AND NOT l.granted AND $2=ANY(pg_blocking_pids(l.pid))`, [waiter, blocker])).rows[0].n;
      if (waiting > 0) return;
      await delay(10); // Observer pacing only: unlock happens after actual pg_locks evidence.
    }
    throw new Error("Expected PostgreSQL lock wait was not observed");
  }
  async function twoConnections(action) {
    const first = await runtime.connect(), second = await runtime.connect();
    try {
      await first.query("BEGIN"); await second.query("BEGIN");
      await first.query("SET LOCAL statement_timeout='5s'"); await second.query("SET LOCAL statement_timeout='5s'");
      const firstPid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await action(first, second, firstPid, secondPid);
    } finally {
      await Promise.allSettled([first.query("ROLLBACK"), second.query("ROLLBACK")]);
      first.release(); second.release();
    }
  }
  try {
    await check("restricted runtime and migration-owned projection reject PUBLIC execution", async () => {
      const who = (await runtime.query(`SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolreplication,
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS membership,
        pg_has_role(current_user,d.datdba,'MEMBER') AS database_owner,
        has_database_privilege(current_user,current_database(),'CREATE,TEMPORARY') AS ddl
        FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
      assert.ok(Object.values(who).every(value => value === false));
      const functions = (await owner.query(`SELECT p.oid,p.prosecdef,p.proconfig,p.proowner=d.datdba AS migration_owner,
        has_function_privilege($1,p.oid,'EXECUTE') AS runtime_execute,
        EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
        FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_database d ON d.datname=current_database()
        WHERE t.tgrelid='story_revision'::regclass AND NOT t.tgisinternal AND p.prosecdef`, [decodeURIComponent(runtimeTarget.username)])).rows;
      assert.equal(functions.length, 1);
      assert.equal(functions[0].migration_owner, true); assert.equal(functions[0].runtime_execute, false);
      assert.equal(functions[0].public_execute, false); assert.ok(functions[0].proconfig.includes("search_path=pg_catalog"));
      await rejectCode(runtime.query("SELECT public.mq_project_revision_assets()"), "42501");
      for (const relation of ["story_revision_asset", "AdminGrant"]) {
        assert.equal((await runtime.query("SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed", [`public."${relation}"`])).rows[0].allowed, false);
      }
    });
    const asset = await readyAsset(), extraAsset = await readyAsset();
    const attached = await createStory(v2(asset, asset));
    await check("READY assets project once per revision and may be shared across stories", async () => {
      assert.deepEqual(await refs(attached.revisionId), [{ asset_id: asset, required_state: "READY" }]);
      const second = await createStory(v2(asset, extraAsset));
      assert.deepEqual((await refs(second.revisionId)).map(row => row.asset_id), [asset, extraAsset].sort());
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM story_revision_asset WHERE asset_id=$1", [asset])).rows[0].n, 2);
      assert.equal((await runtime.query("SELECT content FROM story_revision WHERE id=$1", [attached.revisionId])).rows[0].content.blocks.length, 3);
    });
    await check("runtime cannot mutate projection or attach an asset to an old revision", async () => {
      for (const query of [
        () => runtime.query("INSERT INTO story_revision_asset(revision_id,asset_id) VALUES ($1,$2)", [attached.revisionId, extraAsset]),
        () => runtime.query("UPDATE story_revision_asset SET asset_id=$1 WHERE revision_id=$2", [extraAsset, attached.revisionId]),
        () => runtime.query("DELETE FROM story_revision_asset WHERE revision_id=$1", [attached.revisionId]),
        () => runtime.query("TRUNCATE story_revision_asset"),
        () => runtime.query("UPDATE story_revision SET content=$1::jsonb WHERE id=$2", [JSON.stringify(v2(extraAsset)), attached.revisionId]),
        () => runtime.query("UPDATE story SET state='PUBLISHED',published_revision_id=draft_revision_id,version=version+1 WHERE id=$1", [attached.id]),
      ]) await rejectCode(query(), "42501");
      assert.deepEqual(await refs(attached.revisionId), [{ asset_id: asset, required_state: "READY" }]);
    });
    await check("native projection guards reject direct owner DML and immutable revision edits", async () => {
      for (const query of [
        () => owner.query("INSERT INTO story_revision_asset(revision_id,asset_id) VALUES ($1,$2)", [attached.revisionId, extraAsset]),
        () => owner.query("UPDATE story_revision_asset SET asset_id=$1 WHERE revision_id=$2", [extraAsset, attached.revisionId]),
        () => owner.query("DELETE FROM story_revision_asset WHERE revision_id=$1", [attached.revisionId]),
        () => owner.query("TRUNCATE story_revision_asset"),
        () => owner.query("UPDATE story_revision SET content=$1::jsonb WHERE id=$2", [JSON.stringify(v2(extraAsset)), attached.revisionId]),
      ]) await rejectCode(query(), "23514");
    });
    await check("unknown, pending, failed, deleting and deleted assets cannot be referenced", async () => {
      await rejectCode(createStory(v2(randomUUID())), "23503");
      for (const status of ["PENDING", "FAILED", "DELETING", "DELETED"]) {
        const id = await pendingAsset();
        if (status !== "PENDING") await runtime.query("UPDATE media_asset SET state=$1 WHERE id=$2", [status === "DELETED" ? "DELETING" : status, id]);
        if (status === "DELETED") await runtime.query("UPDATE media_asset SET state='DELETED' WHERE id=$1", [id]);
        await rejectCode(createStory(v2(id)), "23503");
      }
    });
    await check("native v2 validation rejects malformed or excessive content before retaining references", async () => {
      const malformed = [
        { blocks: [paragraph] }, { version: null, blocks: [paragraph] },
        { version: 2 }, { version: 2, blocks: null },
        { version: 2, blocks: [] }, { version: 2, blocks: Array(201).fill(paragraph) },
        { version: 2, blocks: [paragraph], unexpected: true },
        { version: 2, blocks: [null] },
        { version: 2, blocks: [{ text: "synthetic" }] },
        { version: 2, blocks: [{ type: null, text: "synthetic" }] },
        { version: 2, blocks: [{ type: "html", html: "synthetic" }] },
        { version: 2, blocks: [{ type: "paragraph" }] },
        { version: 2, blocks: [{ type: "paragraph", text: null }] },
        { version: 2, blocks: [{ type: "paragraph", text: " " }] },
        { version: 2, blocks: [{ type: "paragraph", text: "x".repeat(10001) }] },
        { version: 2, blocks: [{ ...paragraph, style: null }] },
        { version: 2, blocks: [{ ...paragraph, style: "unsupported" }] },
        { version: 2, blocks: [{ type: "image", alt: "synthetic" }] },
        { version: 2, blocks: [{ type: "image", assetId: null, alt: "synthetic" }] },
        { version: 2, blocks: [{ type: "image", assetId: "invalid", alt: "synthetic" }] },
        { version: 2, blocks: [{ type: "image", assetId: asset }] },
        { version: 2, blocks: [{ type: "image", assetId: asset, alt: null }] },
        { version: 2, blocks: [{ type: "image", assetId: asset, alt: "" }] },
        { version: 2, blocks: [{ type: "image", assetId: asset, alt: "x".repeat(301) }] },
        { version: 2, blocks: [{ type: "image", assetId: asset, alt: "synthetic", caption: null }] },
        { version: 2, blocks: [{ type: "image", assetId: asset, alt: "synthetic", caption: "x".repeat(1001) }] },
        { version: 2, blocks: [{ type: "image", assetId: asset, alt: "synthetic", src: "https://example.invalid/image" }] },
        { version: 2, blocks: Array(30).fill({ type: "paragraph", text: "x".repeat(10000) }) },
      ];
      const before = (await owner.query("SELECT (SELECT count(*) FROM story)::int AS stories,(SELECT count(*) FROM story_revision)::int AS revisions,(SELECT count(*) FROM story_revision_asset)::int AS refs")).rows[0];
      for (const content of malformed) await rejectCode(createStory(content), "23514");
      assert.deepEqual((await owner.query("SELECT (SELECT count(*) FROM story)::int AS stories,(SELECT count(*) FROM story_revision)::int AS revisions,(SELECT count(*) FROM story_revision_asset)::int AS refs")).rows[0], before);
    });
    await check("v1 synthetic content remains unchanged and creates no managed media projection", async () => {
      const content = { version: 1, blocks: [{ type: "image", src: "/scene/night-sky.webp", alt: "Legacy synthetic image" }] };
      const legacy = await createStory(content);
      assert.deepEqual((await runtime.query("SELECT content FROM story_revision WHERE id=$1", [legacy.revisionId])).rows[0].content, content);
      assert.deepEqual(await refs(legacy.revisionId), []);
    });
    await check("asset identity and completed metadata are immutable; lifecycle transitions are constrained", async () => {
      await rejectCode(owner.query("UPDATE media_asset SET id=$1 WHERE id=$2", [randomUUID(), asset]), "23514");
      await rejectCode(owner.query("UPDATE media_asset SET storage_key=$1 WHERE id=$2", [randomUUID(), asset]), "23514");
      await rejectCode(owner.query("UPDATE media_asset SET display_width=999 WHERE id=$1", [asset]), "23514");
      await rejectCode(owner.query("UPDATE media_asset SET display_sha256=repeat('c',64) WHERE id=$1", [asset]), "23514");
      const storedKey = (await owner.query("SELECT storage_key FROM media_asset WHERE id=$1", [asset])).rows[0].storage_key;
      await rejectCode(owner.query("INSERT INTO media_asset(id,storage_key) VALUES ($1,$2)", [randomUUID(), storedKey]), "23505");
      await rejectCode(owner.query("UPDATE media_asset SET state='PENDING' WHERE id=$1", [asset]), "23514");
      const pending = await pendingAsset();
      await rejectCode(runtime.query("UPDATE media_asset SET state='READY' WHERE id=$1", [pending]), "23514");
      await rejectCode(runtime.query("UPDATE media_asset SET display_width=1 WHERE id=$1", [pending]), "23514");
      const completeMetadata = ["image/webp", 800, 600, 1000, "a".repeat(64), "image/webp", 160, 120, 100, "b".repeat(64)];
      for (const [index, column] of metadataColumns.entries()) {
        const incompleteMetadata = [...completeMetadata]; incompleteMetadata[index] = null;
        await rejectCode(runtime.query(`UPDATE media_asset SET state='READY',${metadataColumns.map((name, position) => `${name}=$${position + 2}`).join(",")} WHERE id=$1`,
          [pending, ...incompleteMetadata]), "23514");
        const unchanged = (await runtime.query(`SELECT state,${metadataColumns.join(",")} FROM media_asset WHERE id=$1`, [pending])).rows[0];
        assert.equal(unchanged.state, "PENDING", `${column}: rejected READY transition must retain PENDING`);
        assert.ok(metadataColumns.every(name => unchanged[name] === null), `${column}: rejected READY transition must retain empty metadata`);
      }
      await rejectCode(runtime.query(`UPDATE media_asset SET state='READY',display_mime_type='image/svg+xml',display_width=1,display_height=1,display_bytes=1,display_sha256=repeat('a',64),
        thumbnail_mime_type='image/webp',thumbnail_width=1,thumbnail_height=1,thumbnail_bytes=1,thumbnail_sha256=repeat('b',64) WHERE id=$1`, [pending]), "23514");
      await rejectCode(runtime.query(`UPDATE media_asset SET state='READY',display_mime_type='image/webp',display_width=1,display_height=1,display_bytes=1,display_sha256='invalid',
        thumbnail_mime_type='image/webp',thumbnail_width=1,thumbnail_height=1,thumbnail_bytes=1,thumbnail_sha256=repeat('b',64) WHERE id=$1`, [pending]), "23514");
      await makeReady(pending);
      await runtime.query("UPDATE media_asset SET state='DELETING' WHERE id=$1", [pending]);
      await runtime.query("UPDATE media_asset SET state='DELETED' WHERE id=$1", [pending]);
      await rejectCode(runtime.query("UPDATE media_asset SET state='READY' WHERE id=$1", [pending]), "23514");
      assert.equal((await runtime.query("SELECT state FROM media_asset WHERE id=$1", [pending])).rows[0].state, "DELETED");
    });
    await check("historical references prevent deletion even after the active draft removes the image", async () => {
      const image = await readyAsset(), story = await createStory(v2(image)), replacement = randomUUID();
      await transaction(runtime, async connection => {
        await insertRevision(connection, story.id, replacement, v1);
        await connection.query("UPDATE story SET draft_revision_id=$1,version=version+1 WHERE id=$2 AND version=0", [replacement, story.id]);
      });
      await rejectCode(runtime.query("UPDATE media_asset SET state='DELETING' WHERE id=$1", [image]), "23001");
      await rejectCode(owner.query("DELETE FROM media_asset WHERE id=$1", [image]), "23514");
      assert.equal((await refs(story.revisionId)).length, 1);
    });
    await check("reference-first transaction blocks deletion until FK rejects it after commit", async () => {
      const image = await readyAsset(), story = await createStory(), revision = randomUUID();
      await twoConnections(async (first, second, firstPid, secondPid) => {
        await insertRevision(first, story.id, revision, v2(image));
        const deletion = second.query("UPDATE media_asset SET state='DELETING' WHERE id=$1", [image])
          .then(() => "SUCCESS", error => error.code);
        await waitForLock(secondPid, firstPid);
        await first.query("COMMIT");
        assert.equal(await deletion, "23001"); await second.query("ROLLBACK");
      });
      assert.equal((await refs(revision)).length, 1);
      assert.equal((await runtime.query("SELECT state FROM media_asset WHERE id=$1", [image])).rows[0].state, "READY");
    });
    await check("deletion-first transaction blocks a new reference and leaves no revision after rollback", async () => {
      const image = await readyAsset(), story = await createStory(), revision = randomUUID();
      await twoConnections(async (first, second, firstPid, secondPid) => {
        await first.query("UPDATE media_asset SET state='DELETING' WHERE id=$1", [image]);
        const insertion = insertRevision(second, story.id, revision, v2(image)).then(() => "SUCCESS", error => error.code);
        await waitForLock(secondPid, firstPid);
        await first.query("COMMIT");
        assert.equal(await insertion, "23503"); await second.query("ROLLBACK");
      });
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM story_revision WHERE id=$1", [revision])).rows[0].n, 0);
      assert.deepEqual(await refs(revision), []);
    });
    await check("concurrent CAS loser rolls back both its immutable revision and media projection", async () => {
      const story = await createStory(), images = [await readyAsset(), await readyAsset()], revisions = [randomUUID(), randomUUID()];
      await twoConnections(async (first, second, firstPid, secondPid) => {
        await insertRevision(first, story.id, revisions[0], v2(images[0]));
        await insertRevision(second, story.id, revisions[1], v2(images[1]));
        const update = "UPDATE story SET draft_revision_id=$1,version=version+1 WHERE id=$2 AND version=0";
        assert.equal((await first.query(update, [revisions[0], story.id])).rowCount, 1);
        const loser = second.query(update, [revisions[1], story.id])
          .then(result => ({ count: result.rowCount }), error => ({ code: error.code }));
        await waitForLock(secondPid, firstPid); await first.query("COMMIT");
        assert.deepEqual(await loser, { count: 0 });
        // The application must propagate its CAS conflict; this transaction is
        // deliberately rolled back rather than committing an unused revision.
        await second.query("ROLLBACK");
      });
      const result = (await runtime.query("SELECT draft_revision_id,version FROM story WHERE id=$1", [story.id])).rows[0];
      assert.deepEqual(result, { draft_revision_id: revisions[0], version: 1 });
      assert.equal((await refs(revisions[0])).length, 1); assert.deepEqual(await refs(revisions[1]), []);
      assert.equal((await runtime.query("SELECT count(*)::int AS n FROM story_revision WHERE story_id=$1", [story.id])).rows[0].n, 2);
    });
    await check("public reader supports current published v2 while excluding private revisions and withdrawn bodies", async () => {
      const publicContent = v2(await readyAsset());
      const story = await createStory(publicContent);
      assert.equal(await publicReader.getStory(story.id), null);
      assert.equal(await publicReader.getStoryBySlug(story.slug), null);
      assert.ok(!(await publicReader.listStories()).some(item => item.id === story.id));
      await owner.query("UPDATE story SET slot_id='star-1',version=version+1 WHERE id=$1", [story.id]);
      await owner.query("UPDATE story SET state='PUBLISHED',published_revision_id=draft_revision_id,version=version+1 WHERE id=$1", [story.id]);
      const summary = await publicReader.getSummaryBySlug(story.slug);
      assert.deepEqual(Object.keys(summary).sort(), ["entry", "id", "slug", "slotId", "title"].sort());
      assert.deepEqual((await publicReader.getStory(story.id)).content, publicContent);
      assert.deepEqual((await publicReader.getStoryBySlug(story.slug)).content, publicContent);
      const privateContent = v2(await readyAsset()), privateRevision = randomUUID();
      await transaction(runtime, async connection => {
        await insertRevision(connection, story.id, privateRevision, privateContent);
        await connection.query("UPDATE story SET draft_revision_id=$1,version=version+1 WHERE id=$2", [privateRevision, story.id]);
      });
      assert.deepEqual((await publicReader.getStory(story.id)).content, publicContent);
      assert.deepEqual((await publicReader.getStoryBySlug(story.slug)).content, publicContent);
      await owner.query("UPDATE story SET state='WITHDRAWN',version=version+1 WHERE id=$1", [story.id]);
      assert.equal(await publicReader.getStory(story.id), null);
      assert.equal(await publicReader.getStoryBySlug(story.slug), null);
      assert.equal(await publicReader.getSummaryBySlug(story.slug), null);
      assert.ok(!(await publicReader.listStories()).some(item => item.id === story.id));
    });
  } catch (error) {
    const safe = new Error("Media PostgreSQL assertion failed; raw details withheld");
    safe.mediaStage = stage; safe.code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR";
    throw safe;
  } finally { await Promise.allSettled([owner.end(), runtime.end(), publicClient.$disconnect()]); }
  return { passed, total: 13 };
}
