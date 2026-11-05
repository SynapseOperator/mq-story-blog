import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { URL } from "node:url";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { createStoryService } from "../../src/server/stories/service.ts";
import { initializeAdmin, revokeAdmin, restoreAdmin } from "../../src/server/admin/maintenance.ts";
import { assertTemporaryTarget, transport, observeWait, commentPath, moderatePath, createCommentFixtures,
  assertReceipt, assertCommentPage, assertModerated, assertCommentError, submitAndDropResponse } from "./test-support.mjs";

/** All submissions and moderation use the real HTTP routes. Owner connections
 * inspect synthetic rows, reset independent test quotas and inject bounded faults. */
export async function runCommentHttpTests({ connectionString, maintenanceUrl, runtimeRole, origin, authSecret, ca, backendOrigin, restartServer }) {
  assertTemporaryTarget(connectionString); assertTemporaryTarget(maintenanceUrl);
  assert.match(runtimeRole, /^mq_admin_rt_[a-f0-9]{32}$/);
  const owner = new pg.Pool({ connectionString, max: 5 });
  const trusted = createAuthDatabaseClient(connectionString), maintenance = createAuthDatabaseClient(maintenanceUrl);
  const stories = createStoryService(trusted), secrets = new Set(), logOnly = new Set();
  const send = transport(origin, secrets, ca), accounts = [], jars = [{}, {}];
  const admin = { username: `moderator_${randomBytes(5).toString("hex")}`, password: `MqComment!${randomBytes(24).toString("base64url")}` };
  secrets.add(admin.password); secrets.add(authSecret);
  let adminJar = {}, grant, fixtures, lastHttp, passed = 0, stage = "fixtures";
  const quota = () => owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
  const row = async id => (await owner.query("SELECT * FROM story_comment WHERE id=$1", [id])).rows[0];
  const allRows = async () => (await owner.query("SELECT * FROM story_comment ORDER BY id")).rows;
  const publicCount = async id => (await owner.query("SELECT count(*)::int AS n FROM story_comment WHERE story_id=$1 AND state='APPROVED'", [id])).rows[0].n;
  async function request(path, options = {}) {
    const response = await send(path, options);
    lastHttp = { method: options.method ?? "GET", path: path.split("?", 1)[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<synthetic-id>"),
      status: response.status, code: /^[A-Z_]+$/.test(response.data?.code ?? "") ? response.data.code : undefined,
      count: Number.isSafeInteger(response.data?.count) ? response.data.count : undefined };
    return response;
  }
  async function collectSecrets() {
    const rows = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
    rows.forEach(item => secrets.add(item.value));
  }
  async function check(name, action) {
    stage = name; await quota(); await action(); await collectSecrets(); passed++;
    console.log(`PASS comments ${ca ? "HTTPS" : "HTTP"}: ${name}`);
  }
  function submit(storyId, text, { identity = "anonymous", jar, key = randomUUID(), ...extra } = {}) {
    logOnly.add(text); secrets.add(key);
    return request(commentPath(storyId), { method: "POST", body: { body: text, identity }, jar,
      ...extra, headers: { "idempotency-key": key, ...extra.headers } });
  }
  const moderate = (id, action, expectedVersion, extra = {}) => request(moderatePath(id), {
    method: "POST", jar: adminJar, body: { action, expectedVersion }, ...extra,
  });
  async function approve(id) {
    const before = await row(id);
    return assertModerated(await moderate(id, "approve", before.version), { id, state: "APPROVED", version: before.version + 1 });
  }
  async function login(account) {
    const jar = {}, response = await request("/api/auth/sign-in/username", { method: "POST", body: account, jar });
    assert.equal(response.status, 200); assert.ok(jar.cookie); secrets.add(jar.cookie);
    if (ca) assert.ok(response.cookieLines.some(line => /^__Secure-mq\.session_token=/.test(line)
      && /;\s*Secure(?:;|$)/i.test(line) && /;\s*HttpOnly(?:;|$)/i.test(line) && /;\s*SameSite=Lax(?:;|$)/i.test(line)));
    await collectSecrets(); return jar;
  }
  try {
    fixtures = await createCommentFixtures(trusted);
    fixtures.privateCanaries.forEach(value => logOnly.add(value));
    const id = fixtures.first.id;
    await check("anonymous submission is pending, not public, and private stories share a 404", async () => {
      assertCommentPage(await request(commentPath(id)), { count: 0 });
      const receipt = assertReceipt(await submit(id, "合成匿名待审留言"));
      const stored = await row(receipt);
      assert.equal(stored.body, "合成匿名待审留言"); assert.equal(stored.user_id, null);
      assert.equal(stored.state, "PENDING"); assert.equal(stored.version, 0);
      assertCommentPage(await request(commentPath(id)), { count: 0 });
      assertCommentError(await submit(id, "合成未登录账号留言", { identity: "account" }), 401, "COMMENT_UNAUTHENTICATED");
      for (const storyId of ["not-a-story", "11111111-1111-4111-8111-11111111111z", randomUUID(), fixtures.draft.id, fixtures.withdrawn.id]) {
        await quota();
        assertCommentError(await request(commentPath(storyId)), 404, "COMMENT_NOT_FOUND");
        assertCommentError(await submit(storyId, "合成不可公开故事留言"), 404, "COMMENT_NOT_FOUND");
      }
    });
    await check("real ordinary accounts cannot enter moderation and only the maintained administrator can", async () => {
      for (let index = 0; index < 2; index++) {
        const account = { username: `comment_${randomBytes(6).toString("hex")}`, password: `MqReader!${randomBytes(24).toString("base64url")}` };
        accounts.push(account); secrets.add(account.password);
        assert.equal((await request("/api/auth/sign-up/email", { method: "POST", body: account, jar: jars[index] })).status, 200);
        assert.ok(jars[index].cookie); secrets.add(jars[index].cookie);
      }
      grant = await initializeAdmin(maintenance, admin); adminJar = await login(admin);
      for (const path of ["/api/admin/comments", moderatePath(randomUUID())]) {
        const options = path.endsWith("moderate") ? { method: "POST", body: { action: "approve", expectedVersion: 0 } } : {};
        assert.equal((await request(path, options)).status, 401);
        assert.equal((await request(path, { ...options, jar: jars[0], headers: { "x-role": "admin", "x-user-id": grant.userId } })).status, 403);
      }
      assertCommentPage(await request("/api/admin/comments", { jar: adminJar }), { admin: true, count: 1 });
    });
    await check("explicit anonymous mode stays anonymous while account identity comes only from its signed session", async () => {
      const anonymous = assertReceipt(await submit(id, "合成登录后选择匿名", { jar: jars[0] }));
      assert.equal((await row(anonymous)).user_id, null);
      const account = assertReceipt(await submit(id, "合成账号待审留言", { identity: "account", jar: jars[0],
        headers: { "x-user-id": grant.userId, "x-role": "admin" } }));
      const user = (await owner.query('SELECT id FROM "User" WHERE username=$1', [accounts[0].username])).rows[0];
      assert.equal((await row(account)).user_id, user.id); assert.equal((await row(account)).state, "PENDING");
      await approve(anonymous); await approve(account);
      const page = assertCommentPage(await request(commentPath(id)), { count: 2 });
      assert.equal(page.items.find(item => item.id === anonymous).author, "匿名访客");
      assert.equal(page.items.find(item => item.id === account).author, accounts[0].username);
    });
    await check("concurrent same-key submissions create one row and retries never disclose later moderation", async () => {
      const key = randomUUID(), text = "合成并发幂等留言";
      const results = await Promise.all(Array.from({ length: 4 }, () => submit(id, `  ${text}\n`, { key })));
      const receipt = assertReceipt(results[0]); results.forEach(response => assert.equal(assertReceipt(response), receipt));
      const hash = createHash("sha256").update(key).digest("hex");
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_comment WHERE submission_key_hash=$1", [hash])).rows[0].n, 1);
      await approve(receipt); await quota();
      assert.deepEqual((await submit(id, text, { key: key.toUpperCase() })).data, results[0].data);
      for (const [storyId, body, options] of [[id, `${text}不同`, {}], [fixtures.second.id, text, {}],
        [id, text, { identity: "account", jar: jars[0] }]]) {
        await quota(); assertCommentError(await submit(storyId, body, { key, ...options }), 409, "COMMENT_CONFLICT");
      }
      await quota();
      const accountKey = randomUUID(); assertReceipt(await submit(id, "合成账号幂等隔离", { key: accountKey, identity: "account", jar: jars[0] }));
      assertCommentError(await submit(id, "合成账号幂等隔离", { key: accountKey, identity: "account", jar: jars[1] }), 409, "COMMENT_CONFLICT");
    });
    await check("a real discarded response can be retried with the same receipt and no duplicate row", async () => {
      const key = randomUUID(), body = { body: "合成丢失响应留言", identity: "anonymous" };
      secrets.add(key); logOnly.add(body.body);
      await submitAndDropResponse(origin, commentPath(id), { ca, key, body });
      const hash = createHash("sha256").update(key).digest("hex");
      const before = (await owner.query("SELECT * FROM story_comment WHERE submission_key_hash=$1", [hash])).rows;
      assert.equal(before.length, 1); assert.equal(before[0].state, "PENDING");
      assert.equal(assertReceipt(await submit(id, body.body, { key })), before[0].id);
      assert.deepEqual((await owner.query("SELECT * FROM story_comment WHERE submission_key_hash=$1", [hash])).rows, before);
    });
    await check("trimmed Unicode code points accept 1 and 500 while empty and 501 are rejected", async () => {
      for (const value of ["字", "🌟".repeat(500), "字".repeat(500)]) {
        await quota(); const receipt = assertReceipt(await submit(id, ` \n${value}\t `));
        assert.equal((await row(receipt)).body, value);
        assert.equal((await owner.query("SELECT char_length(body)::int AS n FROM story_comment WHERE id=$1", [receipt])).rows[0].n, Array.from(value).length);
      }
      for (const value of ["", " \n\t ", "字".repeat(501), "🌟".repeat(501)]) {
        await quota(); assertCommentError(await submit(id, value), 400, "COMMENT_VALIDATION");
      }
      await quota();
      const escaped = assertReceipt(await submit(id, "🌟".repeat(500), {
        rawBody: '{"body":"' + "\\ud83c\\udf1f".repeat(500) + '","identity":"anonymous"}',
      }));
      assert.equal((await row(escaped)).body, "🌟".repeat(500));
    });
    await check("HTML and Markdown payloads round-trip as plain JSON strings without interpretation", async () => {
      const value = '<script>globalThis.commentXss=1</script><img src=x onerror="alert(1)">\n**纯文本** [链接](javascript:alert(1))';
      const receipt = assertReceipt(await submit(id, value)); assert.equal((await row(receipt)).body, value);
      await approve(receipt);
      const item = assertCommentPage(await request(`${commentPath(id)}?limit=50`)).items.find(item => item.id === receipt);
      assert.ok(item); assert.equal(item.body, value);
    });
    await check("strict body, UUID key and content boundaries reject client identity or approval injection", async () => {
      const before = await allRows();
      for (const body of [null, [], {}, { body: "文字" }, { body: "文字", identity: "admin" }, { body: 1, identity: "anonymous" },
        ...["userId", "storyId", "state", "version", "author", "moderatedBy"].map(field => ({ body: "文字", identity: "anonymous", [field]: grant.userId }))]) {
        await quota(); assertCommentError(await submit(id, "边界", { body }), 400, "COMMENT_VALIDATION");
      }
      for (const key of ["", "not-a-uuid", "a".repeat(4096)]) {
        await quota(); assertCommentError(await submit(id, "合成非法幂等键", { key }), 400, "COMMENT_VALIDATION");
      }
      await quota();
      assertCommentError(await request(commentPath(id), { method: "POST", body: { body: "无幂等键", identity: "anonymous" } }), 400, "COMMENT_VALIDATION");
      await quota(); assertCommentError(await submit(id, "边界", { rawBody: "{", headers: { "content-type": "application/json" } }), 400, "COMMENT_VALIDATION");
      await quota(); assertCommentError(await submit(id, "边界", { headers: { "content-type": "text/plain" } }), 415, "COMMENT_JSON_REQUIRED");
      await quota(); assertCommentError(await submit(id, "边界", { rawBody: " ".repeat(100_000) + "{}" }), 413, "COMMENT_BODY_TOO_LARGE");
      assert.deepEqual(await allRows(), before);
    });
    await check("missing or foreign Origin and method override cannot submit or moderate", async () => {
      const receipt = assertReceipt(await submit(id, "合成Origin边界留言")), before = await allRows();
      for (const requestOrigin of [null, "null", "https://attacker.invalid"]) {
        await quota(); assertCommentError(await submit(id, "合成CSRF拒绝", { requestOrigin }), 403, "COMMENT_ORIGIN_REJECTED");
        assert.equal((await moderate(receipt, "approve", 0, { requestOrigin })).status, 403);
      }
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        assert.equal((await request(commentPath(id), { method, body: {} })).status, 405);
      }
      await quota(); assertCommentError(await submit(id, "合成方法覆盖拒绝", { headers: { "x-http-method-override": "GET" } }), 400, "COMMENT_VALIDATION");
      assert.deepEqual(await allRows(), before);
    });
    await check("approve, reject and withdraw enforce terminal states and same-version moderation has one CAS winner", async () => {
      const pending = assertReceipt(await submit(id, "合成审核CAS留言"));
      const results = await Promise.all(["approve", "reject"].map(action => moderate(pending, action, 0)));
      assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
      assertCommentError(results.find(response => response.status === 409), 409, "COMMENT_CONFLICT");
      const winner = await row(pending); assert.equal(winner.version, 1); assert.ok(["APPROVED", "REJECTED"].includes(winner.state));
      const rejected = assertReceipt(await submit(id, "PRIVATE_REJECTED_COMMENT_CANARY"));
      assertModerated(await moderate(rejected, "reject", 0), { id: rejected, state: "REJECTED", version: 1 });
      assertCommentError(await moderate(rejected, "approve", 1), 409, "COMMENT_INVALID_STATE");
      const withdrawn = assertReceipt(await submit(id, "PRIVATE_WITHDRAWN_COMMENT_CANARY")); await approve(withdrawn);
      assertModerated(await moderate(withdrawn, "withdraw", 1), { id: withdrawn, state: "WITHDRAWN", version: 2 });
      assertCommentError(await moderate(withdrawn, "approve", 2), 409, "COMMENT_INVALID_STATE");
      assertCommentError(await moderate(randomUUID(), "approve", 0), 404, "COMMENT_NOT_FOUND");
      const before = await allRows();
      for (const body of [{ action: "restore", expectedVersion: 0 }, { action: "approve", expectedVersion: -1 },
        { action: "approve", expectedVersion: "0" }, { action: "approve", expectedVersion: 0, state: "APPROVED" }]) {
        assertCommentError(await moderate(pending, "approve", 0, { body }), 400, "COMMENT_VALIDATION");
      }
      assert.deepEqual(await allRows(), before);
    });
    await check("public pagination defaults to 20, bounds pages and counts only approved rows without duplicates", async () => {
      const storyId = fixtures.second.id, expected = [];
      for (let index = 0; index < 22; index++) {
        await quota(); const receipt = assertReceipt(await submit(storyId, `合成分页留言 ${index + 1}`));
        await approve(receipt); expected.push(receipt);
      }
      await quota(); assertReceipt(await submit(storyId, "PRIVATE_PENDING_PAGE_CANARY"));
      const first = assertCommentPage(await request(commentPath(storyId)), { count: 22 });
      assert.equal(first.items.length, 20); assert.ok(first.nextCursor);
      const second = assertCommentPage(await request(`${commentPath(storyId)}?cursor=${encodeURIComponent(first.nextCursor)}`), { count: 22 });
      assert.equal(second.items.length, 2); assert.equal(second.nextCursor, null);
      assert.deepEqual([...first.items, ...second.items].map(item => item.id).sort(), expected.sort());
      assert.equal(assertCommentPage(await request(`${commentPath(storyId)}?limit=50`), { count: 22 }).items.length, 22);
      for (const query of ["limit=0", "limit=51", "limit=1.5", "limit=word", "cursor=invalid", `cursor=${"x".repeat(2048)}`, "state=PENDING", "userId=forged"]) {
        assertCommentError(await request(`${commentPath(storyId)}?${query}`), 400, "COMMENT_VALIDATION");
      }
    });
    await check("admin filters expose only the moderation DTO and private bodies stay out of all public surfaces", async () => {
      for (const state of ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]) {
        const expected = (await owner.query("SELECT count(*)::int AS n FROM story_comment WHERE story_id=$1 AND state::text=$2", [id, state])).rows[0].n;
        const page = assertCommentPage(await request(`/api/admin/comments?state=${state}&storyId=${id}&limit=50`, { jar: adminJar }), { admin: true, count: expected });
        assert.ok(page.items.every(item => item.state === state && item.storyId === id));
      }
      const first = assertCommentPage(await request("/api/admin/comments?state=APPROVED&limit=2", { jar: adminJar }), { admin: true });
      assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
      const second = assertCommentPage(await request(`/api/admin/comments?state=APPROVED&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`, { jar: adminJar }), { admin: true, count: first.count });
      assert.equal(second.items.length, 2); assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 4);
      for (const query of ["state=ALL", "storyId=invalid", "limit=51", "limit=0", "cursor=invalid", "userId=forged"]) {
        assertCommentError(await request(`/api/admin/comments?${query}`, { jar: adminJar }), 400, "COMMENT_VALIDATION");
      }
      const forbidden = (await owner.query("SELECT body FROM story_comment WHERE state<>'APPROVED'")).rows
        .map(item => item.body).filter(value => value.startsWith("PRIVATE_"));
      assert.ok(forbidden.length >= 3);
      for (const story of [fixtures.first, fixtures.second]) {
        for (const path of [commentPath(story.id), `/api/stories/${story.id}`, `/api/stories/by-slug/${story.slug}`, "/api/stories"]) {
          const response = await request(path); assert.equal(response.status, 200);
          for (const text of forbidden) assert.ok(!response.text.includes(text));
        }
        for (const headers of [{}, { rsc: "1" }, { "user-agent": "Twitterbot/1.0" }]) {
          let response = await request(`/stories/${story.slug}`, { headers });
          if (response.status === 307 && headers.rsc) {
            const location = new URL(response.headers.location, origin); assert.equal(location.origin, origin);
            response = await request(`${location.pathname}${location.search}`, { headers });
          }
          assert.equal(response.status, 200);
          for (const text of forbidden) assert.ok(!response.text.includes(text));
        }
      }
    });
    await check("actual anonymous retry quota returns 429 and Retry-After without additional rows", async () => {
      const key = randomUUID(), text = "合成限流幂等留言";
      let receipt;
      for (let index = 0; index < 5; index++) {
        const current = assertReceipt(await submit(id, text, { key })); receipt ??= current; assert.equal(current, receipt);
      }
      const before = await allRows();
      for (const options of [{ key }, { key: randomUUID(), headers: { "x-forwarded-for": "203.0.113.8", "x-real-ip": "203.0.113.9" } }]) {
        const response = await submit(id, text, options); assertCommentError(response, 429, "COMMENT_RATE_LIMITED");
        assert.match(response.headers["retry-after"] ?? "", /^[1-9][0-9]*$/);
      }
      assert.deepEqual(await allRows(), before);
      assertCommentPage(await request(commentPath(id)), { count: await publicCount(id) });
    });
    await check("account and global quotas apply to actual POST routes without storing raw identities", async () => {
      const user = (await owner.query('SELECT id FROM "User" WHERE username=$1', [accounts[0].username])).rows[0];
      const accountKey = createHmac("sha256", authSecret).update(`comments:account:${user.id}`).digest("hex");
      const globalKey = createHmac("sha256", authSecret).update("comments:global").digest("hex");
      assertReceipt(await submit(id, "合成账号额度初始化", { identity: "account", jar: jars[0] }));
      const buckets = (await owner.query('SELECT "key","count" FROM "AuthRateLimit"')).rows;
      assert.equal(buckets.length, 3); assert.ok(buckets.every(bucket => /^[a-f0-9]{64}$/.test(bucket.key)));
      assert.ok(buckets.some(bucket => bucket.key === accountKey && bucket.count === 1));
      assert.equal((await owner.query('UPDATE "AuthRateLimit" SET "count"=8 WHERE "key"=$1', [accountKey])).rowCount, 1);
      const before = await allRows();
      for (const identity of ["account", "anonymous"]) {
        const response = await submit(id, "合成账号额度拒绝", { identity, jar: jars[0] });
        assertCommentError(response, 429, "COMMENT_RATE_LIMITED"); assert.match(response.headers["retry-after"] ?? "", /^[1-9][0-9]*$/);
      }
      assert.deepEqual(await allRows(), before);
      await quota(); assertReceipt(await submit(id, "合成全站额度初始化"));
      assert.equal((await owner.query('UPDATE "AuthRateLimit" SET "count"=120 WHERE "key"=$1', [globalKey])).rowCount, 1);
      const globalBefore = await allRows();
      assertCommentError(await submit(id, "合成全站额度拒绝"), 429, "COMMENT_RATE_LIMITED");
      assert.deepEqual(await allRows(), globalBefore);
    });
    await check("expired, deleted, logged-out and forged sessions cannot submit under an account", async () => {
      const user = (await owner.query('SELECT id FROM "User" WHERE username=$1', [accounts[0].username])).rows[0];
      for (const invalidate of [
        () => owner.query('UPDATE "Session" SET "expiresAt"=CURRENT_TIMESTAMP-INTERVAL \'1 minute\' WHERE "userId"=$1', [user.id]),
        () => owner.query('DELETE FROM "Session" WHERE "userId"=$1', [user.id]),
        () => request("/api/auth/sign-out", { method: "POST", body: {}, jar: { ...jars[0] } }),
      ]) {
        await quota(); jars[0] = await login(accounts[0]); const stale = { ...jars[0] }; await invalidate();
        assertCommentError(await submit(id, "合成失效账号拒绝", { identity: "account", jar: stale }), 401, "COMMENT_UNAUTHENTICATED");
        const anonymous = assertReceipt(await submit(id, "合成失效会话仍可匿名", { jar: stale })); assert.equal((await row(anonymous)).user_id, null);
      }
      await quota(); assertCommentError(await submit(id, "合成伪造签名拒绝", { identity: "account",
        jar: { cookie: `${ca ? "__Secure-" : ""}mq.session_token=forged` } }), 401, "COMMENT_UNAUTHENTICATED");
      jars[0] = await login(accounts[0]);
    });
    await check("revoked and expired administrator sessions cannot moderate and restoration requires new login", async () => {
      const receipt = assertReceipt(await submit(id, "合成撤权待审留言")), before = await row(receipt);
      grant = await revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      assert.equal((await moderate(receipt, "approve", 0)).status, 401);
      assert.equal((await request("/api/admin/comments", { jar: adminJar })).status, 401);
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      assert.equal((await moderate(receipt, "approve", 0)).status, 401);
      adminJar = await login(admin);
      await owner.query('UPDATE "Session" SET "expiresAt"=CURRENT_TIMESTAMP-INTERVAL \'1 minute\' WHERE "userId"=$1', [grant.userId]);
      assert.equal((await moderate(receipt, "approve", 0)).status, 401);
      assert.deepEqual(await row(receipt), before); adminJar = await login(admin); await approve(receipt);
    });
    await check("withdrawn stories reject public reads, submissions and approvals but permit reject or withdraw", async () => {
      const pending = assertReceipt(await submit(id, "合成下架待审留言")), approved = assertReceipt(await submit(id, "合成下架已审核留言"));
      await approve(approved);
      let story = await trusted.story.findUniqueOrThrow({ where: { id } });
      story = await stories.withdraw({ storyId: id, expectedVersion: story.version });
      assertCommentError(await request(commentPath(id)), 404, "COMMENT_NOT_FOUND");
      assertCommentError(await submit(id, "合成下架提交拒绝"), 404, "COMMENT_NOT_FOUND");
      assertCommentError(await moderate(pending, "approve", 0), 404, "COMMENT_NOT_FOUND");
      assert.equal((await row(pending)).state, "PENDING");
      assertModerated(await moderate(pending, "reject", 0), { id: pending, state: "REJECTED", version: 1 });
      assertModerated(await moderate(approved, "withdraw", 1), { id: approved, state: "WITHDRAWN", version: 2 });
      await stories.restore({ storyId: id, expectedVersion: story.version });
      const page = assertCommentPage(await request(`${commentPath(id)}?limit=50`), { count: await publicCount(id) });
      assert.ok(page.items.every(item => ![pending, approved].includes(item.id)));
    });
    await check("withdrawal holding the real Story lock wins against an in-flight anonymous submission", async () => {
      const lock = await owner.connect(); let pending;
      const before = await allRows();
      try {
        await lock.query("BEGIN"); await lock.query("SELECT id FROM story WHERE id=$1 FOR UPDATE", [id]);
        pending = submit(id, "合成下架竞争不得插入");
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')");
        await lock.query("UPDATE story SET state='WITHDRAWN',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1", [id]);
        await lock.query("COMMIT"); assertCommentError(await pending, 404, "COMMENT_NOT_FOUND");
      } finally { await lock.query("ROLLBACK"); lock.release(); await pending?.catch(() => {}); }
      assert.deepEqual(await allRows(), before);
      const story = await trusted.story.findUniqueOrThrow({ where: { id } });
      await stories.restore({ storyId: id, expectedVersion: story.version });
    });
    await check("revocation holding the grant lock wins against an in-flight moderation request", async () => {
      const receipt = assertReceipt(await submit(id, "合成审核撤权竞争")), before = await row(receipt);
      const lock = await owner.connect(); let pending;
      try {
        await lock.query("BEGIN"); await lock.query('SELECT id FROM "AdminGrant" WHERE id=1 FOR UPDATE');
        pending = moderate(receipt, "approve", 0);
        await observeWait(owner, runtimeRole, "wait_event IN ('transactionid','tuple')");
        await lock.query('UPDATE "AdminGrant" SET "revokedAt"=clock_timestamp(),version=version+1 WHERE id=1');
        await lock.query("COMMIT"); assert.equal((await pending).status, 403);
      } finally { await lock.query("ROLLBACK"); lock.release(); await pending?.catch(() => {}); }
      assert.deepEqual(await row(receipt), before);
      const current = (await owner.query('SELECT version FROM "AdminGrant" WHERE id=1')).rows[0];
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: current.version }); adminJar = await login(admin);
    });
    await check("production restart preserves private rows, public count and idempotent receipts", async () => {
      const key = randomUUID(), text = "合成重启持久化留言";
      const receipt = assertReceipt(await submit(id, text, { key })); await approve(receipt);
      const before = await allRows(), count = await publicCount(id);
      await restartServer();
      assert.deepEqual(await allRows(), before);
      assertCommentPage(await request(commentPath(id)), { count });
      assert.equal(assertReceipt(await submit(id, text, { key })), receipt);
      adminJar = await login(admin); assertCommentPage(await request("/api/admin/comments", { jar: adminJar }), { admin: true });
    });
    await check("database privilege failures are redacted 503 responses and cannot masquerade as an empty list", async () => {
      const before = await allRows();
      await owner.query(`REVOKE SELECT ON story_comment FROM "${runtimeRole}"`);
      try {
        assertCommentError(await request(commentPath(id)), 503, "COMMENT_UNAVAILABLE");
        assertCommentError(await submit(id, "合成数据库拒绝留言"), 503, "COMMENT_UNAVAILABLE");
        assert.equal((await request("/api/admin/comments", { jar: adminJar })).status, 503);
      } finally { await owner.query(`GRANT SELECT ON story_comment TO "${runtimeRole}"`); }
      assert.deepEqual(await allRows(), before); assertCommentPage(await request(commentPath(id)), { count: await publicCount(id) });
    });
    if (ca) await check("verified HTTPS uses secure signed cookies and direct backend or spoofed proxy claims cannot authorize writes", async () => {
      adminJar = await login(admin); jars[0] = await login(accounts[0]);
      const before = await allRows();
      for (const headers of [{}, { "x-mq-proxy-key": "untrusted", "x-mq-client-ip": "203.0.113.1" }]) {
        const response = await globalThis.fetch(`${backendOrigin}${commentPath(id)}`, { method: "POST",
          headers: { ...headers, "content-type": "application/json", origin, "idempotency-key": randomUUID(), cookie: jars[0].cookie },
          body: JSON.stringify({ body: "合成直连拒绝留言", identity: "account" }) });
        assert.equal(response.status, 403);
      }
      assert.deepEqual(await allRows(), before);
      const receipt = assertReceipt(await submit(id, "合成代理剥离伪造头", { identity: "account", jar: jars[0],
        headers: { "x-mq-proxy-key": "client-supplied", "x-mq-client-ip": "malformed,client" } }));
      assert.equal((await row(receipt)).state, "PENDING");
    });
    await collectSecrets();
    const pendingId = (await owner.query("SELECT id FROM story_comment WHERE story_id=$1 AND state='PENDING' ORDER BY id LIMIT 1", [id])).rows[0].id;
    return { passed, total: ca ? 22 : 21, fixtures, secrets,
      adminJar, pendingId, logOnly: [...logOnly].filter(value => value.length >= 8), publicCount: await publicCount(id) };
  } catch (error) {
    const location = error.stack?.split("\n").filter(line => line.trim().startsWith("at ") && /scripts[\\/]comments[\\/]/.test(line)).slice(0, 3);
    console.error(`Comments HTTP diagnostic: ${JSON.stringify({ ...lastHttp, location,
      actual: typeof error.actual === "number" || typeof error.actual === "boolean" ? error.actual : undefined,
      expected: typeof error.expected === "number" || typeof error.expected === "boolean" ? error.expected : undefined })}`);
    error.commentsStage = stage; throw error;
  } finally { await Promise.allSettled([owner.end(), trusted.$disconnect(), maintenance.$disconnect()]); }
}
