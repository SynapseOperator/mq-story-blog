import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { createStoryOperations, createStoryService } from "../../src/server/stories/service.ts";
import { createAdminDraftReader } from "../../src/server/stories/admin-drafts.ts";
import { assertDraftDatabasePrivileges } from "../../src/server/stories/draft-privileges.ts";
import { assertTemporaryTarget, content, observeWait } from "./test-support.mjs";

export async function runDraftDatabaseTests({ connectionString, runtimeUrl, runtimeRole }) {
  const target = assertTemporaryTarget(connectionString);
  const runtimeTarget = assertTemporaryTarget(runtimeUrl);
  assert.equal(runtimeTarget.pathname, target.pathname);
  assert.equal(runtimeTarget.host, target.host);
  assert.equal(runtimeTarget.username, runtimeRole);
  const owner = new pg.Pool({ connectionString, max: 5 });
  const restricted = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
  const runtime = createAuthDatabaseClient(runtimeUrl);
  const trusted = createAuthDatabaseClient(connectionString);
  const internal = createStoryService(trusted);
  let passed = 0;
  let current = "initialization";
  const run = async (name, action) => { current = name; await action(); passed++; console.log(`PASS draft database: ${name}`); };
  const create = (title = "Synthetic database draft") => runtime.$transaction(tx => createStoryOperations(tx).createDraft({
    slug: `story-${randomUUID().replaceAll("-", "")}`, kind: "STAR", title, content: content("Synthetic private draft body"),
  }));
  const count = async storyId => Number((await owner.query("SELECT count(*) FROM story_revision WHERE story_id=$1", [storyId])).rows[0].count);
  try {
    await run("restricted runtime ACL permits only reviewed draft writes", async () => {
      await runtime.$transaction(tx => assertDraftDatabasePrivileges(tx));
      assert.equal((await restricted.query("SELECT current_user")).rows[0].current_user, runtimeRole);
    });
    const draft = await create();
    await run("create uses database defaults and deferred owned revision under column-level INSERT", async () => {
      const row = (await owner.query("SELECT state,version,slot_id,published_revision_id FROM story WHERE id=$1", [draft.id])).rows[0];
      assert.deepEqual(row, { state: "DRAFT", version: 0, slot_id: null, published_revision_id: null });
      assert.equal(await count(draft.id), 1);
      const detail = await runtime.$transaction(tx => createAdminDraftReader(tx).get(draft.id));
      assert.equal(detail.story.id, draft.id);
      assert.equal(detail.draft.title, "Synthetic database draft");
    });
    await run("save appends an immutable revision without changing identity or publication", async () => {
      const saved = await runtime.$transaction(tx => createStoryOperations(tx).saveDraft({ storyId: draft.id, expectedVersion: 0,
        title: "Synthetic saved draft", content: content("Synthetic edited body") }));
      assert.equal(saved.version, 1);
      assert.equal(saved.slug, draft.slug);
      assert.equal(saved.publishedRevisionId, null);
      assert.equal(await count(draft.id), 2);
    });
    await run("real concurrent CAS has exactly one winner and no losing revision", async () => {
      const lock = randomBytes(4).readUInt32BE() % 2_000_000_000;
      const gate = await owner.connect();
      let attempts = [];
      try {
        await owner.query(`CREATE FUNCTION mq_test_draft_cas_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(${lock}); RETURN NEW; END; $$`);
        await owner.query("CREATE TRIGGER mq_test_draft_cas_gate BEFORE INSERT ON story_revision FOR EACH ROW EXECUTE FUNCTION mq_test_draft_cas_gate()");
        await gate.query("SELECT pg_advisory_lock($1)", [lock]);
        attempts = ["A", "B"].map(marker => runtime.$transaction(tx => createStoryOperations(tx).saveDraft({ storyId: draft.id, expectedVersion: 1,
          title: `Synthetic concurrent ${marker}`, content: content(`Synthetic concurrency ${marker}`) })));
        const settled = Promise.allSettled(attempts);
        await observeWait(owner, runtimeRole, "wait_event='advisory'", 2);
        await gate.query("SELECT pg_advisory_unlock($1)", [lock]);
        const outcomes = await settled;
        assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
        const failed = outcomes.find(result => result.status === "rejected");
        assert.equal(failed.reason.code, "CONFLICT");
        assert.equal(await count(draft.id), 3);
      } finally {
        await gate.query("SELECT pg_advisory_unlock($1)", [lock]).catch(() => {});
        await Promise.allSettled(attempts);
        await owner.query("DROP TRIGGER IF EXISTS mq_test_draft_cas_gate ON story_revision");
        await owner.query("DROP FUNCTION IF EXISTS mq_test_draft_cas_gate()");
        gate.release();
      }
    });
    await run("operation callback failure rolls back revision and story mutation", async () => {
      const before = (await owner.query("SELECT * FROM story WHERE id=$1", [draft.id])).rows[0];
      const revisions = await count(draft.id);
      await assert.rejects(runtime.$transaction(async tx => {
        await createStoryOperations(tx).saveDraft({ storyId: draft.id, expectedVersion: before.version, title: "Synthetic rollback", content: content("Synthetic rollback") });
        throw new Error("SYNTHETIC_AFTER_WRITE_FAILURE");
      }));
      assert.deepEqual((await owner.query("SELECT * FROM story WHERE id=$1", [draft.id])).rows[0], before);
      assert.equal(await count(draft.id), revisions);
    });
    await run("deferred foreign-key failure at commit rolls back inserted revision", async () => {
      const before = (await owner.query("SELECT * FROM story WHERE id=$1", [draft.id])).rows[0];
      const revisions = await count(draft.id);
      await assert.rejects(runtime.$transaction(async tx => {
        await createStoryOperations(tx).saveDraft({ storyId: draft.id, expectedVersion: before.version, title: "Synthetic deferred failure", content: content("Synthetic deferred failure") });
        await tx.$executeRaw`UPDATE story SET draft_revision_id=${randomUUID()}::uuid, version=version+1 WHERE id=${draft.id}::uuid`;
      }));
      assert.deepEqual((await owner.query("SELECT * FROM story WHERE id=$1", [draft.id])).rows[0], before);
      assert.equal(await count(draft.id), revisions);
    });
    await run("invalid content and stale version cannot create any new revision", async () => {
      const before = await count(draft.id);
      await assert.rejects(runtime.$transaction(tx => createStoryOperations(tx).saveDraft({ storyId: draft.id, expectedVersion: 2, title: "Bad content", content: { version: 1, blocks: [{ type: "html", html: "<script>bad</script>" }] } })), e => e.code === "VALIDATION");
      await assert.rejects(runtime.$transaction(tx => createStoryOperations(tx).saveDraft({ storyId: draft.id, expectedVersion: 0, title: "Stale content", content: content("Synthetic stale") })), e => e.code === "CONFLICT");
      assert.equal(await count(draft.id), before);
    });
    await run("published and withdrawn saves preserve original public revision and slot", async () => {
      let story = await internal.createDraft({ slug: `published-${randomUUID()}`, kind: "STAR", slotId: "star-1", title: "Synthetic public snapshot", content: content("Synthetic public snapshot") });
      story = await internal.publish({ storyId: story.id, expectedVersion: story.version });
      const publicBefore = await internal.getPublicStory(story.slug);
      const edited = await runtime.$transaction(tx => createStoryOperations(tx).saveDraft({ storyId: story.id, expectedVersion: story.version,
        title: "PRIVATE_CHANGED_TITLE", content: content("PRIVATE_CHANGED_BODY") }));
      assert.equal(edited.publishedRevisionId, story.publishedRevisionId);
      assert.equal(edited.slotId, story.slotId);
      assert.deepEqual(await internal.getPublicStory(story.slug), publicBefore);
      const withdrawn = await internal.withdraw({ storyId: story.id, expectedVersion: edited.version });
      const hidden = await runtime.$transaction(tx => createStoryOperations(tx).saveDraft({ storyId: story.id, expectedVersion: withdrawn.version,
        title: "PRIVATE_WITHDRAWN_TITLE", content: content("PRIVATE_WITHDRAWN_BODY") }));
      assert.equal(hidden.state, "WITHDRAWN");
      assert.equal(hidden.publishedRevisionId, story.publishedRevisionId);
      assert.equal(hidden.slotId, story.slotId);
      assert.equal(await internal.getPublicStory(story.slug), null);
    });
    await run("runtime cannot INSERT or UPDATE protected publication or slot columns", async () => {
      for (const column of ["state", "published_revision_id", "slot_id"]) {
        await assert.rejects(restricted.query(`UPDATE story SET ${column}=${column} WHERE id=$1`, [draft.id]), e => e.code === "42501");
      }
      await assert.rejects(restricted.query("INSERT INTO story(id,slug,kind,draft_revision_id,state) VALUES($1,$2,'CAMPFIRE',$3,'PUBLISHED')", [randomUUID(), `denied-${randomUUID()}`, randomUUID()]), e => e.code === "42501");
      await assert.rejects(restricted.query("INSERT INTO story(id,slug,kind,draft_revision_id,slot_id) VALUES($1,$2,'STAR',$3,'star-2')", [randomUUID(), `denied-${randomUUID()}`, randomUUID()]), e => e.code === "42501");
    });
    await run("runtime cannot mutate historical revisions, identities, grants or schema", async () => {
      for (const statement of ["UPDATE story SET slug=slug", "DELETE FROM story", "UPDATE story_revision SET title=title", "DELETE FROM story_revision", "UPDATE star_slot SET scene_key=scene_key", 'UPDATE "AdminGrant" SET version=version', "CREATE TABLE public.mq_test_forbidden(value integer)"]) {
        await assert.rejects(restricted.query(statement), e => e.code === "42501");
      }
    });
    await run("effective forbidden column and table privilege drift are rejected", async () => {
      for (const grant of ["UPDATE(state)", "INSERT(published_revision_id)", "UPDATE", "INSERT"]) {
        current = `ACL drift: ${grant}`;
        await owner.query(`GRANT ${grant} ON story TO "${runtimeRole}"`);
        try { await assert.rejects(runtime.$transaction(tx => assertDraftDatabasePrivileges(tx))); }
        finally {
          await owner.query(`REVOKE ${grant} ON story FROM "${runtimeRole}"`);
          // PostgreSQL's table REVOKE also removes matching column privileges;
          // restore the exact reviewed grants in this owned disposable target.
          if (grant === "UPDATE") await owner.query(`GRANT UPDATE (draft_revision_id,version,updated_at) ON story TO "${runtimeRole}"`);
          if (grant === "INSERT") await owner.query(`GRANT INSERT (id,slug,kind,draft_revision_id) ON story TO "${runtimeRole}"`);
        }
      }
      current = "ACL restored after drift probes";
      await runtime.$transaction(tx => assertDraftDatabasePrivileges(tx));
    });
    await run("raw PostgreSQL campfire uniqueness maps to a safe domain conflict", async () => {
      const make = () => runtime.$transaction(tx => createStoryOperations(tx).createDraft({
        slug: `story-${randomUUID().replaceAll("-", "")}`, kind: "CAMPFIRE", title: "Synthetic domain campfire", content: content("Synthetic campfire") }));
      await make();
      try { await make(); assert.fail("Second campfire must be rejected"); }
      catch (error) {
        assert.equal(error.code, "CONFLICT");
      }
    });
    return { passed, total: 12 };
  } catch {
    console.error(`Draft database regression failed at: ${current} (sensitive details withheld)`);
    throw new Error("Draft database regression failed");
  } finally { await Promise.allSettled([owner.end(), restricted.end(), runtime.$disconnect(), trusted.$disconnect()]); }
}
