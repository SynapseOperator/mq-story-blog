import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { storySlotClasses } from "../../src/lib/stories/scene-catalog.ts";
import { createStoryService } from "../../src/server/stories/service.ts";

const syntheticContent = (text = "合成测试内容，不包含真实故事或照片。") => ({
  version: 1,
  blocks: [{ type: "paragraph", text }],
});

function domainCode(code) {
  return (error) => error.code === code;
}

// Adapter errors may expose PostgreSQL SQLSTATE directly or as a normalized
// cause. Never log the error object: adapters can include connection details.
function databaseCode(code) {
  const adapterKinds = {
    "23503": "ForeignKeyConstraintViolation",
    "23505": "UniqueConstraintViolation",
    "23514": "CheckConstraintViolation",
  };
  return (error) => {
    const visited = new Set();
    function contains(value, depth = 0) {
      if (value === code || value === adapterKinds[code]) return true;
      if (depth > 8 || !value || typeof value !== "object" || visited.has(value)) return false;
      visited.add(value);
      return Object.getOwnPropertyNames(value).some((key) => contains(value[key], depth + 1));
    }
    return contains(error);
  };
}

/** Runs only inside the caller's two freshly migrated, disposable databases.
 * No database names, URLs, credentials, reset, cleanup, or existing app records
 * enter this module. The outer integration runner owns database teardown.
 */
export async function runStoryIntegration(client, isolatedClient, pass, setStage = () => {}) {
  const service = createStoryService(client);
  const token = randomUUID().replaceAll("-", "");
  let sequence = 0;
  const slug = (label) => `synthetic-${label}-${token}-${sequence++}`;
  const createDraft = (label, extra = {}) => service.createDraft({
    slug: slug(label), kind: "STAR", title: "合成故事：初始草稿", content: syntheticContent(), ...extra,
  });
  const createSlot = (label) => client.starSlot.create({
    data: { id: `test-${label}-${token}`, sceneKey: `test-scene-${label}-${token}` },
  });
  const storyRow = (id) => client.story.findUniqueOrThrow({ where: { id } });
  const revisionCount = (id) => client.storyRevision.count({ where: { storyId: id } });
  async function check(name, run) {
    const stage = `story domain: ${name}`;
    setStage(stage);
    try { await run(); }
    catch (error) { error.storyStage = stage; throw error; }
    pass(stage);
  }

  let accepted;
  let donor;
  let firstPublic;
  let secondPublic;
  let restoredDraft;

  await check("seeded slot identities match the accepted scene mapping", async () => {
    const expected = Object.entries(storySlotClasses).map(([id, sceneKey]) => ({ id, sceneKey }));
    assert.deepEqual(await client.starSlot.findMany({ orderBy: { id: "asc" } }), expected);
    assert.deepEqual(await isolatedClient.starSlot.findMany({ orderBy: { id: "asc" } }), expected);
    assert.equal(await client.story.count(), 0);
    assert.equal(await isolatedClient.story.count(), 0);
  });

  await check("all four added slots publish, retain exclusive bindings and restore public content", async () => {
    for (const slotId of ["star-4", "star-5", "star-6", "star-7"]) {
      let story = await createDraft(slotId, { slotId });
      await assert.rejects(createDraft(`${slotId}-occupied`, { slotId }), domainCode("CONFLICT"));
      story = await service.publish({ storyId: story.id, expectedVersion: story.version });
      const published = await service.getPublicStory(story.slug);
      assert.equal(published.slotId, slotId);
      assert.deepEqual(published.revision.content, syntheticContent());
      story = await service.withdraw({ storyId: story.id, expectedVersion: story.version });
      assert.equal(await service.getPublicStory(story.slug), null);
      await assert.rejects(createDraft(`${slotId}-withdrawn`, { slotId }), domainCode("CONFLICT"));
      story = await service.restore({ storyId: story.id, expectedVersion: story.version });
      assert.deepEqual(await service.getPublicStory(story.slug), published);
    }
  });

  await check("a new draft is private and an unbound star cannot publish", async () => {
    accepted = await createDraft("accepted");
    assert.equal(accepted.state, "DRAFT");
    assert.equal(accepted.version, 0);
    assert.equal(accepted.slotId, null);
    assert.equal(accepted.publishedRevisionId, null);
    assert.equal(await revisionCount(accepted.id), 1);
    assert.equal(await service.getPublicStory(accepted.slug), null);
    await assert.rejects(service.publish({ storyId: accepted.id, expectedVersion: accepted.version }), domainCode("INVALID_STATE"));
    assert.deepEqual(await storyRow(accepted.id), accepted);
  });

  await check("a draft can reserve and release a slot without moving any slot identity", async () => {
    accepted = await service.reserveSlot({ storyId: accepted.id, expectedVersion: accepted.version, slotId: "star-1" });
    assert.equal(accepted.slotId, "star-1");
    await assert.rejects(createDraft("occupied-draft", { slotId: "star-1" }), domainCode("CONFLICT"));
    accepted = await service.reserveSlot({ storyId: accepted.id, expectedVersion: accepted.version, slotId: null });
    assert.equal(accepted.slotId, null);
    accepted = await service.reserveSlot({ storyId: accepted.id, expectedVersion: accepted.version, slotId: "star-1" });
    assert.equal(accepted.version, 3);
    assert.equal(await service.getPublicStory(accepted.slug), null);
    assert.equal(await revisionCount(accepted.id), 1);
  });

  await check("first publication atomically exposes the current owned revision", async () => {
    accepted = await service.publish({ storyId: accepted.id, expectedVersion: accepted.version });
    firstPublic = accepted.publishedRevisionId;
    assert.equal(accepted.state, "PUBLISHED");
    assert.equal(firstPublic, accepted.draftRevisionId);
    const publicStory = await service.getPublicStory(accepted.slug);
    assert.equal(publicStory.id, accepted.id);
    assert.equal(publicStory.slotId, "star-1");
    assert.equal(publicStory.revision.id, firstPublic);
    assert.deepEqual(publicStory.revision.content, syntheticContent());
    assert.equal(Object.hasOwn(publicStory, "draftRevisionId"), false);
    await assert.rejects(service.publish({ storyId: accepted.id, expectedVersion: accepted.version }), domainCode("INVALID_STATE"));
    await assert.rejects(service.reserveSlot({ storyId: accepted.id, expectedVersion: accepted.version, slotId: null }), domainCode("INVALID_STATE"));
  });

  await check("saving a published draft preserves public content until explicit publish", async () => {
    accepted = await service.saveDraft({ storyId: accepted.id, expectedVersion: accepted.version,
      title: "合成故事：待发布修改", content: syntheticContent("这段合成内容仅在明确发布后公开。") });
    assert.notEqual(accepted.draftRevisionId, firstPublic);
    assert.equal(accepted.publishedRevisionId, firstPublic);
    assert.equal((await service.getPublicStory(accepted.slug)).revision.id, firstPublic);
    assert.equal((await service.getPublicStory(accepted.slug)).revision.title, "合成故事：初始草稿");
    accepted = await service.publish({ storyId: accepted.id, expectedVersion: accepted.version });
    secondPublic = accepted.publishedRevisionId;
    assert.equal(secondPublic, accepted.draftRevisionId);
    assert.notEqual(secondPublic, firstPublic);
    assert.equal((await service.getPublicStory(accepted.slug)).revision.title, "合成故事：待发布修改");
    assert.equal((await client.storyRevision.findUniqueOrThrow({ where: { id: firstPublic } })).title, "合成故事：初始草稿");
  });

  await check("withdrawal hides content but keeps its slot reserved at database level", async () => {
    accepted = await service.withdraw({ storyId: accepted.id, expectedVersion: accepted.version });
    assert.equal(accepted.state, "WITHDRAWN");
    assert.equal(accepted.slotId, "star-1");
    assert.equal(accepted.publishedRevisionId, secondPublic);
    assert.equal(await service.getPublicStory(accepted.slug), null);
    await assert.rejects(createDraft("occupied-withdrawn", { slotId: "star-1" }), domainCode("CONFLICT"));
    donor = await createDraft("donor");
    await assert.rejects(client.$executeRaw`
      UPDATE story SET slot_id = 'star-1', version = version + 1 WHERE id = ${donor.id}::uuid
    `, databaseCode("23505"));
    assert.deepEqual(await storyRow(donor.id), donor);
    await assert.rejects(service.publish({ storyId: accepted.id, expectedVersion: accepted.version }), domainCode("INVALID_STATE"));
    await assert.rejects(service.withdraw({ storyId: accepted.id, expectedVersion: accepted.version }), domainCode("INVALID_STATE"));
  });

  await check("restore exposes the old public revision and leaves a newer draft private", async () => {
    accepted = await service.saveDraft({ storyId: accepted.id, expectedVersion: accepted.version,
      title: "合成故事：下架期间的私有修改", content: syntheticContent("恢复不能偷偷发布这份草稿。") });
    restoredDraft = accepted.draftRevisionId;
    assert.notEqual(restoredDraft, secondPublic);
    assert.equal(await service.getPublicStory(accepted.slug), null);
    accepted = await service.restore({ storyId: accepted.id, expectedVersion: accepted.version });
    assert.equal(accepted.state, "PUBLISHED");
    assert.equal(accepted.publishedRevisionId, secondPublic);
    assert.equal(accepted.draftRevisionId, restoredDraft);
    assert.equal((await service.getPublicStory(accepted.slug)).revision.id, secondPublic);
    await assert.rejects(service.restore({ storyId: accepted.id, expectedVersion: accepted.version }), domainCode("INVALID_STATE"));
    accepted = await service.publish({ storyId: accepted.id, expectedVersion: accepted.version });
    assert.equal((await service.getPublicStory(accepted.slug)).revision.id, restoredDraft);
  });

  await check("invalid lifecycle calls leave drafts and public records unchanged", async () => {
    await assert.rejects(service.withdraw({ storyId: donor.id, expectedVersion: donor.version }), domainCode("INVALID_STATE"));
    await assert.rejects(service.restore({ storyId: donor.id, expectedVersion: donor.version }), domainCode("INVALID_STATE"));
    await assert.rejects(service.saveDraft({ storyId: randomUUID(), expectedVersion: 0,
      title: "合成故事", content: syntheticContent() }), domainCode("NOT_FOUND"));
    assert.deepEqual(await storyRow(donor.id), donor);
    assert.equal(await service.getPublicStory(slug("missing")), null);
    assert.equal((await service.getPublicStory(accepted.slug)).revision.id, restoredDraft);
  });

  await check("stale edits fail without advancing a revision or overwriting the winner", async () => {
    const before = await storyRow(accepted.id);
    const count = await revisionCount(accepted.id);
    await assert.rejects(service.saveDraft({ storyId: accepted.id, expectedVersion: accepted.version - 1,
      title: "不能覆盖的过期编辑", content: syntheticContent() }), domainCode("CONFLICT"));
    await assert.rejects(service.withdraw({ storyId: accepted.id, expectedVersion: accepted.version - 1 }), domainCode("CONFLICT"));
    assert.deepEqual(await storyRow(accepted.id), before);
    assert.equal(await revisionCount(accepted.id), count);
  });

  await check("concurrent reservations of one empty slot have exactly one winner", async () => {
    const slot = await createSlot("race");
    const left = await createDraft("race-left");
    const right = await createDraft("race-right");
    const results = await Promise.allSettled([left, right].map((story) => service.reserveSlot({
      storyId: story.id, expectedVersion: story.version, slotId: slot.id,
    })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "CONFLICT");
    assert.equal(await client.story.count({ where: { slotId: slot.id } }), 1);
    const rows = await Promise.all([storyRow(left.id), storyRow(right.id)]);
    assert.deepEqual(rows.map((row) => row.version).sort(), [0, 1]);
    assert.equal(rows.filter((row) => row.slotId === null).length, 1);
    assert.equal(await revisionCount(left.id), 1);
    assert.equal(await revisionCount(right.id), 1);
  });

  await check("concurrent saves use optimistic version checks and leave no orphan revision", async () => {
    const story = await createDraft("edit-race");
    const [{ database }] = await client.$queryRaw`SELECT current_database() AS database`;
    let unlock;
    let locked;
    let lockFailed;
    let blockerPid;
    const release = new Promise((resolve) => { unlock = resolve; });
    const ready = new Promise((resolve, reject) => { locked = resolve; lockFailed = reject; });
    // A real row lock permits both service reads but blocks their revision FK
    // checks. This proves the loser reaches the write path, not just an early
    // stale-version read. Use the other test DB as observer, not a mock client.
    const blocker = client.$transaction(async (tx) => {
      [{ pid: blockerPid }] = await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
      await tx.$queryRaw`SELECT id FROM story WHERE id = ${story.id}::uuid FOR UPDATE`;
      locked();
      await release;
    }, { timeout: 10_000 });
    const blockerResult = Promise.allSettled([blocker]);
    void blocker.catch(lockFailed);
    let pending;
    let results;
    try {
      await ready;
      pending = Promise.allSettled(["甲", "乙"].map((suffix) => service.saveDraft({
        storyId: story.id, expectedVersion: story.version, title: `合成并发编辑${suffix}`, content: syntheticContent(),
      })));
      const deadline = Date.now() + 2_500;
      let waiting = 0;
      while (Date.now() < deadline) {
        const [observed] = await isolatedClient.$queryRaw`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = ${database} AND wait_event_type = 'Lock'
            AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
            AND query ILIKE '%INSERT%story_revision%'
        `;
        waiting = observed.waiting;
        if (waiting === 2) break;
        await setTimeout(25);
      }
      assert.equal(waiting, 2, "both revisions must wait after reading the same story version");
    } finally {
      unlock();
      const [lockOutcome] = await blockerResult;
      if (pending) results = await pending;
      assert.equal(lockOutcome.status, "fulfilled", "test-only row lock must release normally");
    }
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "CONFLICT");
    const winner = results.find((result) => result.status === "fulfilled").value;
    const stored = await storyRow(story.id);
    assert.equal(stored.version, 1);
    assert.equal(stored.draftRevisionId, winner.draftRevisionId);
    assert.equal(await revisionCount(story.id), 2);
  });

  await check("a failed transaction rolls back both new revision and story pointer", async () => {
    const before = await storyRow(donor.id);
    const revisionId = randomUUID();
    await assert.rejects(client.$transaction(async (tx) => {
      await tx.storyRevision.create({ data: { id: revisionId, storyId: donor.id,
        title: "必须回滚的合成版本", content: syntheticContent() } });
      await tx.story.update({ where: { id: donor.id }, data: { draftRevisionId: revisionId, version: { increment: 1 } } });
      throw new Error("intentional-story-transaction-rollback");
    }), /intentional-story-transaction-rollback/);
    assert.equal(await client.storyRevision.findUnique({ where: { id: revisionId } }), null);
    assert.deepEqual(await storyRow(donor.id), before);
  });

  await check("composite foreign keys reject cross-story draft ownership at commit", async () => {
    const before = await storyRow(accepted.id);
    let reachedCommit = false;
    await assert.rejects(client.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE story SET draft_revision_id = ${donor.draftRevisionId}::uuid,
        version = version + 1 WHERE id = ${accepted.id}::uuid`;
      reachedCommit = true;
    }), databaseCode("23503"));
    assert.equal(reachedCommit, true, "ownership FK must be checked at transaction commit");
    assert.deepEqual(await storyRow(accepted.id), before);
  });

  await check("composite foreign keys reject cross-story public ownership and roll back", async () => {
    const target = await createDraft("foreign-public", { slotId: "star-2" });
    let reachedDeferredCheck = false;
    await assert.rejects(client.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE story SET state = 'PUBLISHED',
        draft_revision_id = ${donor.draftRevisionId}::uuid,
        published_revision_id = ${donor.draftRevisionId}::uuid,
        version = version + 1 WHERE id = ${target.id}::uuid`;
      reachedDeferredCheck = true;
      // Publishing must point at the draft, so this deliberately invalid row
      // has two foreign pointers. Check the PUBLIC FK explicitly to prove that
      // constraint independently, rather than passing on the draft FK alone.
      await tx.$executeRaw`SET CONSTRAINTS story_id_published_revision_id_fkey IMMEDIATE`;
    }), databaseCode("23503"));
    assert.equal(reachedDeferredCheck, true);
    assert.deepEqual(await storyRow(target.id), target);
    assert.equal(await service.getPublicStory(target.slug), null);
  });

  await check("published revisions cannot be rewritten or deleted through raw SQL", async () => {
    const revision = await client.storyRevision.findUniqueOrThrow({ where: { id: restoredDraft } });
    await assert.rejects(client.$executeRaw`UPDATE story_revision SET title = '非法覆盖'
      WHERE id = ${restoredDraft}::uuid`, databaseCode("23514"));
    await assert.rejects(client.$executeRaw`DELETE FROM story_revision
      WHERE id = ${restoredDraft}::uuid`, databaseCode("23514"));
    assert.deepEqual(await client.storyRevision.findUniqueOrThrow({ where: { id: restoredDraft } }), revision);
  });

  await check("raw SQL cannot change stable identities, published bindings, or skip versions", async () => {
    await assert.rejects(client.$executeRaw`UPDATE story SET slot_id = 'star-3',
      version = version + 1 WHERE id = ${accepted.id}::uuid`, databaseCode("23514"));
    await assert.rejects(client.$executeRaw`UPDATE story SET slug = ${slug("renamed")},
      version = version + 1 WHERE id = ${donor.id}::uuid`, databaseCode("23514"));
    await assert.rejects(client.$executeRaw`UPDATE story SET draft_revision_id = draft_revision_id
      WHERE id = ${donor.id}::uuid`, databaseCode("23514"));
    await assert.rejects(client.$executeRaw`UPDATE star_slot SET scene_key = 'changed-position'
      WHERE id = 'star-1'`, databaseCode("23514"));
    assert.equal((await storyRow(accepted.id)).slotId, "star-1");
    assert.deepEqual(await storyRow(donor.id), donor);
    assert.equal((await client.starSlot.findUniqueOrThrow({ where: { id: "star-1" } })).sceneKey, storySlotClasses["star-1"]);
  });

  await check("raw state checks reject skipped publication and invalid public pointers", async () => {
    await assert.rejects(client.$executeRaw`UPDATE story SET state = 'WITHDRAWN',
      published_revision_id = draft_revision_id, version = version + 1
      WHERE id = ${donor.id}::uuid`, databaseCode("23514"));
    await assert.rejects(client.$executeRaw`UPDATE story SET state = 'PUBLISHED',
      version = version + 1 WHERE id = ${donor.id}::uuid`, databaseCode("23514"));
    await assert.rejects(client.$executeRaw`UPDATE story SET state = 'DRAFT',
      published_revision_id = NULL, version = version + 1
      WHERE id = ${accepted.id}::uuid`, databaseCode("23514"));
    assert.deepEqual(await storyRow(donor.id), donor);
    assert.equal((await storyRow(accepted.id)).state, "PUBLISHED");
  });

  await check("database slug uniqueness is enforced without an application pre-check", async () => {
    await assert.rejects(client.$executeRaw`
      INSERT INTO story (id, slug, kind, draft_revision_id)
      VALUES (${randomUUID()}::uuid, ${accepted.slug}, 'STAR', ${randomUUID()}::uuid)
    `, databaseCode("23505"));
    assert.equal(await client.story.count({ where: { slug: accepted.slug } }), 1);
  });

  await check("one campfire identity is reserved across draft, public, and withdrawn states", async () => {
    let campfire = await createDraft("campfire", { kind: "CAMPFIRE" });
    assert.equal(campfire.slotId, null);
    await assert.rejects(client.$executeRaw`UPDATE story SET slot_id = 'star-3',
      version = version + 1 WHERE id = ${campfire.id}::uuid`, databaseCode("23514"));
    for (const state of ["DRAFT", "PUBLISHED", "WITHDRAWN"]) {
      assert.equal(campfire.state, state);
      await assert.rejects(createDraft("second-campfire", { kind: "CAMPFIRE" }), domainCode("CONFLICT"));
      await assert.rejects(client.$executeRaw`
        INSERT INTO story (id, slug, kind, draft_revision_id)
        VALUES (${randomUUID()}::uuid, ${slug("raw-campfire")}, 'CAMPFIRE', ${randomUUID()}::uuid)
      `, databaseCode("23505"));
      if (state === "DRAFT") campfire = await service.publish({ storyId: campfire.id, expectedVersion: campfire.version });
      else if (state === "PUBLISHED") campfire = await service.withdraw({ storyId: campfire.id, expectedVersion: campfire.version });
    }
    await assert.rejects(client.$executeRaw`UPDATE story SET slot_id = 'star-3',
      version = version + 1 WHERE id = ${campfire.id}::uuid`, databaseCode("23514"));
    assert.equal(await service.getPublicStory(campfire.slug), null);
    campfire = await service.restore({ storyId: campfire.id, expectedVersion: campfire.version });
    assert.equal((await service.getPublicStory(campfire.slug)).kind, "CAMPFIRE");
    assert.equal((await service.getPublicStory(campfire.slug)).slotId, null);
    assert.equal(await client.story.count({ where: { kind: "CAMPFIRE" } }), 1);
  });

  await check("the other temporary database retains only its original slot seed", async () => {
    assert.equal(await isolatedClient.story.count(), 0);
    assert.equal(await isolatedClient.storyRevision.count(), 0);
    assert.deepEqual(await isolatedClient.starSlot.findMany({ orderBy: { id: "asc" } }),
      Object.entries(storySlotClasses).map(([id, sceneKey]) => ({ id, sceneKey })));
    assert.ok(await client.story.count() > 0);
  });
}
