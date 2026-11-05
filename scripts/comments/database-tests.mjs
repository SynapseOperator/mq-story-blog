import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { createStoryCommentOperations } from "../../src/server/comments/service.ts";
import { createStoryService } from "../../src/server/stories/service.ts";
import { assertTemporaryTarget, observeWait } from "../admin-drafts/test-support.mjs";
import { createCommentFixtures } from "./test-support.mjs";

export async function runCommentDatabaseTests({ connectionString, runtimeUrl, maintenanceUrl, runtimeRole, commentOwnerRole, key }) {
  const target = assertTemporaryTarget(connectionString);
  for (const url of [runtimeUrl, maintenanceUrl]) {
    const parsed = assertTemporaryTarget(url); assert.equal(parsed.host, target.host); assert.equal(parsed.pathname, target.pathname);
  }
  const owner = new pg.Pool({ connectionString, max: 5 }), sql = new pg.Pool({ connectionString: runtimeUrl, max: 4 });
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl, max: 2 });
  const trusted = createAuthDatabaseClient(connectionString), runtime = createAuthDatabaseClient(runtimeUrl);
  const keyBytes = Buffer.from(key, "hex"), lifecycle = createStoryService(trusted);
  let passed = 0, stage = "fixtures";
  const check = async (label, run) => { stage = label; await run(); passed++; console.log(`PASS comments PostgreSQL: ${label}`); };
  const failure = code => error => error?.commentCode === code;
  const hash = value => createHash("sha256").update(value).digest("hex");
  const submit = (storyId, principal = null, body = "合成待审核留言", idempotencyKeyHash = hash(randomUUID())) =>
    runtime.$transaction(tx => createStoryCommentOperations(tx).submit(storyId, { principal, body, idempotencyKeyHash }));
  const list = storyId => createStoryCommentOperations(runtime).listPublic(storyId, { limit: 50 });
  const moderate = (id, action, principal, expectedVersion = 0) => runtime.$transaction(tx =>
    createStoryCommentOperations(tx).moderate(id, { action, expectedVersion, principal }, keyBytes));
  async function transaction(pool, run) {
    const tx = await pool.connect();
    try { await tx.query("BEGIN"); const result = await run(tx); await tx.query("COMMIT"); return result; }
    catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }
  async function proof(tx, commentId, principal, action = "approve", expectedVersion = 0) {
    const context = (await tx.query("SELECT current_database() AS db,session_user AS actor,pg_current_xact_id()::text AS xid")).rows[0];
    const comment = (await owner.query("SELECT story_id FROM story_comment WHERE id=$1", [commentId])).rows[0];
    const parts = ["mq-comment-moderation-v1", context.db, context.actor, context.xid, principal.sessionId, principal.userId,
      action, comment.story_id, commentId, String(expectedVersion)];
    const payload = JSON.stringify(parts);
    return { parts, payload, signature: createHmac("sha256", keyBytes).update(payload).digest() };
  }
  const invoke = (tx, value) => tx.query("SELECT public.mq_apply_comment_moderation($1,$2)", [value.payload, value.signature]);
  const row = async id => (await owner.query("SELECT * FROM story_comment WHERE id=$1", [id])).rows[0];
  try {
    const fixtures = await createCommentFixtures(trusted), storyId = fixtures.first.id;
    const principals = [];
    for (let index = 0; index < 2; index++) {
      const userId = randomUUID();
      await trusted.user.create({ data: { id: userId, name: "Synthetic comment identity",
        username: `comment_${randomUUID().replaceAll("-", "").slice(0, 20)}`, email: `${userId}@accounts.invalid` } });
      if (index === 0) await owner.query('INSERT INTO "AdminGrant"("userId") VALUES($1)', [userId]);
      const sessionId = randomUUID();
      await trusted.session.create({ data: { id: sessionId, userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3600_000) } });
      principals.push({ userId, sessionId });
    }
    const [admin, reader] = principals;
    await check("restricted runtime and moderation owner cannot publish stories, read other keys or bypass moderation", async () => {
      for (const statement of ["UPDATE story_comment SET state='APPROVED' WHERE false", "DELETE FROM story_comment WHERE false", "TRUNCATE story_comment",
        "UPDATE story SET state=state WHERE false", 'UPDATE "Session" SET "expiresAt"="expiresAt" WHERE false',
        'UPDATE "User" SET username=username WHERE false', "SELECT secret FROM mq_comment_private.moderation_key", "SELECT secret FROM mq_publish_private.signing_key"]) {
        await assert.rejects(sql.query(statement), { code: "42501" });
      }
      await assert.rejects(sql.query("INSERT INTO story_comment(id,story_id,body,submission_key_hash,state) VALUES($1,$2,'synthetic',$3,'APPROVED')",
        [randomUUID(), storyId, hash(randomUUID())]), { code: "42501" });
      await transaction(owner, async tx => {
        await tx.query(`SET LOCAL ROLE "${commentOwnerRole}"`);
        for (const [relation, column] of [["public.story", "state"], ['public."Session"', "expiresAt"]]) {
          assert.equal((await tx.query("SELECT has_column_privilege(current_user,$1,$2,'UPDATE') AS allowed", [relation, column])).rows[0].allowed, false);
        }
        assert.equal((await tx.query("SELECT has_function_privilege(current_user,'public.mq_apply_story_publication(text,bytea)','EXECUTE') AS allowed")).rows[0].allowed, false);
        assert.equal((await tx.query("SELECT has_table_privilege(current_user,'mq_publish_private.signing_key','SELECT') AS allowed")).rows[0].allowed, false);
      });
      assert.equal((await owner.query(`SELECT count(*)::int AS n FROM pg_proc p,
        LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid='public.mq_apply_comment_moderation(text,bytea)'::regprocedure AND a.grantee=0`)).rows[0].n, 0);
    });
    await check("native inserts are pending, immutable, length bounded and restricted to published stories", async () => {
      const insert = (id, body, state = "PENDING") => owner.query("INSERT INTO story_comment(id,story_id,body,submission_key_hash,state) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), id, body, hash(randomUUID()), state]);
      await assert.rejects(insert(storyId, "不能直接公开", "APPROVED"), { code: "P7200" });
      await assert.rejects(insert(storyId, "😀".repeat(501)), { code: "P7200" });
      for (const id of [fixtures.draft.id, fixtures.withdrawn.id, randomUUID()]) await assert.rejects(insert(id, "不可提交"), { code: "P7204" });
      const receipt = await submit(storyId, reader, "😀".repeat(500));
      const saved = await row(receipt.receiptId); assert.equal(saved.state, "PENDING"); assert.equal(saved.version, 0);
      assert.equal(saved.user_id, reader.userId); assert.equal(saved.moderated_at, null); assert.equal(saved.approved_at, null);
      for (const statement of ["body='changed'", "user_id=NULL", "story_id=gen_random_uuid()", "submission_key_hash=repeat('0',64)"]) {
        await assert.rejects(owner.query(`UPDATE story_comment SET ${statement} WHERE id=$1`, [receipt.receiptId]), { code: "P7200" });
      }
      await assert.rejects(owner.query("UPDATE story_comment SET version=2 WHERE id=$1", [receipt.receiptId]), { code: "P7203" });
      assert.deepEqual(await list(storyId), { items: [], count: 0, nextCursor: null });
    });
    let retryReceipt, retryHash;
    await check("concurrent same-key submissions store one row and identity/story/body changes conflict", async () => {
      retryHash = hash(randomUUID());
      const receipts = await Promise.all(Array.from({ length: 6 }, () => submit(storyId, null, "<script>合成纯文本</script>", retryHash)));
      retryReceipt = receipts[0]; receipts.forEach(receipt => assert.deepEqual(receipt, retryReceipt));
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_comment WHERE submission_key_hash=$1", [retryHash])).rows[0].n, 1);
      for (const args of [[storyId, null, "different"], [storyId, reader, "<script>合成纯文本</script>"], [fixtures.second.id, null, "<script>合成纯文本</script>"]]) {
        await assert.rejects(submit(...args, retryHash), failure("COMMENT_CONFLICT"));
      }
    });
    await check("only approved text is public and retries never reveal later review state", async () => {
      const approved = await moderate(retryReceipt.receiptId, "approve", admin);
      assert.equal(approved.state, "APPROVED"); assert.equal(approved.version, 1); assert.ok(approved.approvedAt);
      const page = await list(storyId); assert.equal(page.count, 1);
      assert.deepEqual(Object.keys(page.items[0]).sort(), ["author", "body", "createdAt", "id"]);
      assert.equal(page.items[0].body, "<script>合成纯文本</script>"); assert.equal(page.items[0].author, "匿名访客");
      assert.deepEqual(await submit(storyId, null, "<script>合成纯文本</script>", retryHash), retryReceipt);
      const withdrawn = await moderate(retryReceipt.receiptId, "withdraw", admin, 1);
      assert.equal(withdrawn.approvedAt, approved.approvedAt); assert.equal((await list(storyId)).count, 0);
      await assert.rejects(moderate(retryReceipt.receiptId, "approve", admin, 2), failure("COMMENT_INVALID_STATE"));
    });
    await check("proof rejects forgery, wrong domain, ordinary identities and cross-transaction replay", async () => {
      const receipt = await submit(storyId);
      for (const change of [value => ({ ...value, signature: Buffer.alloc(32) }), value => ({ ...value, payload: value.payload.replace("mq-comment-moderation-v1", "mq-publish-v1") })]) {
        await assert.rejects(transaction(sql, async tx => invoke(tx, change(await proof(tx, receipt.receiptId, admin)))), { code: "P7201" });
      }
      await assert.rejects(transaction(sql, async tx => invoke(tx, await proof(tx, receipt.receiptId, reader))), { code: "P7201" });
      const stale = await transaction(sql, tx => proof(tx, receipt.receiptId, admin));
      await assert.rejects(transaction(sql, tx => invoke(tx, stale)), { code: "P7201" });
      assert.equal((await row(receipt.receiptId)).state, "PENDING");
    });
    await check("concurrent decisions use CAS and rejected comments cannot be resubmitted for approval", async () => {
      const receipt = await submit(storyId);
      const attempts = await Promise.allSettled([moderate(receipt.receiptId, "approve", admin), moderate(receipt.receiptId, "reject", admin)]);
      assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
      const loser = attempts.find(result => result.status === "rejected"); assert.equal(loser.reason.commentCode, "COMMENT_CONFLICT");
      const rejected = await submit(storyId); await moderate(rejected.receiptId, "reject", admin);
      await assert.rejects(moderate(rejected.receiptId, "approve", admin, 1), failure("COMMENT_INVALID_STATE"));
      await assert.rejects(owner.query("UPDATE story_comment SET state='PENDING',version=version+1 WHERE id=$1", [rejected.receiptId]), { code: "P7205" });
    });
    await check("submission and moderation failures roll back all changes", async () => {
      const submissionHash = hash(randomUUID());
      await assert.rejects(runtime.$transaction(async tx => {
        await createStoryCommentOperations(tx).submit(storyId, { principal: null, body: "rollback", idempotencyKeyHash: submissionHash });
        throw new Error("SYNTHETIC_COMMENT_ROLLBACK");
      }), /SYNTHETIC_COMMENT_ROLLBACK/);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_comment WHERE submission_key_hash=$1", [submissionHash])).rows[0].n, 0);
      const receipt = await submit(storyId);
      await assert.rejects(runtime.$transaction(async tx => {
        await createStoryCommentOperations(tx).moderate(receipt.receiptId, { action: "approve", expectedVersion: 0, principal: admin }, keyBytes);
        throw new Error("SYNTHETIC_COMMENT_ROLLBACK");
      }), /SYNTHETIC_COMMENT_ROLLBACK/);
      assert.equal((await row(receipt.receiptId)).state, "PENDING");
    });
    await check("withdrawal blocks queued submissions/approval while rejection and removal still work", async () => {
      const pendingReceipt = await submit(fixtures.second.id), publicReceipt = await submit(fixtures.second.id);
      await moderate(publicReceipt.receiptId, "approve", admin);
      const gate = await owner.connect(); let submitting, approving;
      try {
        await gate.query("BEGIN"); await gate.query("SELECT id FROM story WHERE id=$1 FOR UPDATE", [fixtures.second.id]);
        submitting = submit(fixtures.second.id); approving = moderate(pendingReceipt.receiptId, "approve", admin);
        const checks = [assert.rejects(submitting, failure("COMMENT_NOT_FOUND")), assert.rejects(approving, failure("COMMENT_NOT_FOUND"))];
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')", 2);
        await gate.query("UPDATE story SET state='WITHDRAWN',version=version+1 WHERE id=$1", [fixtures.second.id]); await gate.query("COMMIT");
        await Promise.all(checks);
      } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled([submitting, approving]); }
      await assert.rejects(list(fixtures.second.id), failure("COMMENT_NOT_FOUND"));
      await moderate(pendingReceipt.receiptId, "reject", admin);
      await moderate(publicReceipt.receiptId, "withdraw", admin, 1);
      const story = await trusted.story.findUniqueOrThrow({ where: { id: fixtures.second.id } });
      await lifecycle.restore({ storyId: story.id, expectedVersion: story.version });
      assert.equal((await list(story.id)).count, 0);
    });
    await check("session revocation winning its lock rejects an account submission", async () => {
      const gate = await owner.connect(); let pending;
      try {
        await gate.query("BEGIN"); await gate.query('SELECT id FROM "Session" WHERE id=$1 FOR UPDATE', [reader.sessionId]);
        pending = submit(storyId, reader); const rejected = assert.rejects(pending, failure("COMMENT_UNAUTHENTICATED"));
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')");
        await gate.query('DELETE FROM "Session" WHERE id=$1', [reader.sessionId]); await gate.query("COMMIT"); await rejected;
      } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => {}); }
    });
    await check("expiry while waiting for the comment row prevents moderation", async () => {
      const receipt = await submit(storyId), sessionId = randomUUID();
      await trusted.session.create({ data: { id: sessionId, userId: admin.userId, token: randomUUID(), expiresAt: new Date(Date.now() + 1500) } });
      const gate = await owner.connect(); let pending;
      try {
        await gate.query("BEGIN"); await gate.query("SELECT id FROM story_comment WHERE id=$1 FOR UPDATE", [receipt.receiptId]);
        pending = moderate(receipt.receiptId, "approve", { ...admin, sessionId });
        const rejected = assert.rejects(pending, failure("COMMENT_FORBIDDEN"));
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')");
        await delay(1600); await gate.query("COMMIT"); await rejected;
      } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => {}); }
      assert.equal((await row(receipt.receiptId)).state, "PENDING");
    });
    await check("expiry during a duplicate-key wait rolls back the eventual account insert", async () => {
      const sessionId = randomUUID(), keyHash = hash(randomUUID()), body = "合成幂等等待";
      await trusted.session.create({ data: { id: sessionId, userId: reader.userId, token: randomUUID(), expiresAt: new Date(Date.now() + 1500) } });
      const gate = await owner.connect(); let pending;
      try {
        await gate.query("BEGIN");
        await gate.query("INSERT INTO story_comment(id,story_id,user_id,body,submission_key_hash) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), storyId, reader.userId, body, keyHash]);
        pending = submit(storyId, { ...reader, sessionId }, body, keyHash);
        const rejected = assert.rejects(pending, failure("COMMENT_UNAUTHENTICATED"));
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')");
        await delay(1600);
        // The competitor disappears: the waiting INSERT would now succeed,
        // so the post-wait session check must roll back this new record too.
        await gate.query("ROLLBACK"); await rejected;
      } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => {}); }
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_comment WHERE submission_key_hash=$1", [keyHash])).rows[0].n, 0);
    });
    await check("administrator revocation wins against a queued signed review", async () => {
      const receipt = await submit(storyId), gate = await maintenance.connect(); let pending;
      try {
        await gate.query("BEGIN"); await gate.query('SELECT id FROM "AdminGrant" WHERE id=1 FOR UPDATE');
        pending = moderate(receipt.receiptId, "approve", admin); const rejected = assert.rejects(pending, failure("COMMENT_FORBIDDEN"));
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')");
        await gate.query('UPDATE "AdminGrant" SET "revokedAt"=clock_timestamp(),version=version+1 WHERE id=1');
        await gate.query("COMMIT"); await rejected;
      } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => {}); }
      assert.equal((await row(receipt.receiptId)).state, "PENDING");
    });
    return { passed, total: 12 };
  } catch (error) { error.commentsStage = stage; throw error; }
  finally { keyBytes.fill(0); await Promise.allSettled([owner.end(), sql.end(), maintenance.end(), trusted.$disconnect(), runtime.$disconnect()]); }
}
