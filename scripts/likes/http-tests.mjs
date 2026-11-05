import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { createStoryService } from "../../src/server/stories/service.ts";
import { assertTemporaryTarget, transport, privateHeaders, assertLikes, createLikeFixtures, likePath } from "./test-support.mjs";

export async function runLikeHttpTests({ connectionString, runtimeRole, origin, ca, backendOrigin, restartServer }) {
  assertTemporaryTarget(connectionString);
  assert.match(runtimeRole, /^mq_admin_rt_[a-f0-9]{32}$/);
  const owner = new pg.Pool({ connectionString, max: 2 }), trusted = createAuthDatabaseClient(connectionString);
  const lifecycle = createStoryService(trusted), secrets = new Set();
  const send = transport(origin, secrets, ca), accounts = [], jars = [{}, {}];
  let lastHttp;
  async function request(path, options = {}) {
    const result = await send(path, options);
    lastHttp = { method: options.method ?? "GET", path: path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<synthetic-id>"),
      status: result.status, code: /^[A-Z_]+$/.test(result.data?.code ?? "") ? result.data.code : undefined,
      count: Number.isSafeInteger(result.data?.count) ? result.data.count : undefined,
      liked: typeof result.data?.liked === "boolean" ? result.data.liked : undefined };
    return result;
  }
  let passed = 0, stage = "fixtures";
  async function collectSecrets() {
    const rows = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
    rows.forEach(row => secrets.add(row.value));
  }
  async function check(name, action) {
    stage = name; await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
    await action(); await collectSecrets(); passed++; console.log(`PASS likes ${ca ? "HTTPS" : "HTTP"}: ${name}`);
  }
  const change = (id, jar, liked, extra = {}) => request(likePath(id), { method: liked ? "PUT" : "DELETE", body: {}, jar, ...extra });
  async function login(index) {
    const jar = {};
    const response = await request("/api/auth/sign-in/username", { method: "POST", body: accounts[index], jar });
    assert.equal(response.status, 200); assert.ok(jar.cookie);
    if (ca) assert.ok(response.cookieLines.some(line => /^__Secure-mq\.session_token=/.test(line)
      && /;\s*Secure(?:;|$)/i.test(line) && /;\s*HttpOnly(?:;|$)/i.test(line) && /;\s*SameSite=Lax(?:;|$)/i.test(line)));
    jars[index] = jar; await collectSecrets(); return jar;
  }
  try {
    const fixtures = await createLikeFixtures(trusted), id = fixtures.first.id;
    fixtures.privateCanaries.forEach(value => secrets.add(value));
    await check("anonymous reads expose only the real count and private stories share a 404", async () => {
      assertLikes(await request(likePath(id)), { count: 0, liked: false });
      for (const storyId of ["not-a-story", "11111111-1111-4111-8111-11111111111z", randomUUID(), fixtures.draft.id, fixtures.withdrawn.id]) {
        const denied = await request(likePath(storyId));
        assert.equal(denied.status, 404); assert.deepEqual(denied.data, { code: "LIKES_NOT_FOUND" }); privateHeaders(denied);
      }
      for (const method of ["PUT", "DELETE"]) {
        const denied = await request(likePath(id), { method, body: {} });
        assert.equal(denied.status, 401); privateHeaders(denied);
      }
    });
    await check("ordinary registration and signed sessions are the only accepted user identity", async () => {
      for (let index = 0; index < 2; index++) {
        const account = { username: `likes_${randomBytes(6).toString("hex")}`, password: `MqLikes!${randomBytes(24).toString("base64url")}` };
        accounts.push(account); secrets.add(account.password);
        assert.equal((await request("/api/auth/sign-up/email", { method: "POST", body: account, jar: jars[index] })).status, 200);
        assert.ok(jars[index].cookie); await collectSecrets();
      }
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM "AdminGrant"')).rows[0].n, 0);
      await login(0); await login(1);
    });
    await check("PUT and DELETE are idempotent, concurrent requests deduplicate and accounts remain independent", async () => {
      const duplicates = await Promise.all(Array.from({ length: 6 }, () => change(id, jars[0], true)));
      duplicates.forEach(response => assertLikes(response, { count: 1, liked: true }));
      assertLikes(await request(likePath(id), { jar: jars[1] }), { count: 1, liked: false });
      assertLikes(await request(likePath(id)), { count: 1, liked: false });
      assertLikes(await change(id, jars[1], true), { count: 2, liked: true });
      for (let n = 0; n < 2; n++) assertLikes(await change(id, jars[0], false), { count: 1, liked: false });
      assertLikes(await change(id, jars[1], false), { count: 0, liked: false });
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_like WHERE story_id=$1", [id])).rows[0].n, 0);
    });
    await check("body and Origin boundaries reject forged identity without changing stored likes", async () => {
      const other = (await owner.query('SELECT id FROM "User" WHERE username=$1', [accounts[1].username])).rows[0].id;
      for (const body of [{ userId: other }, { storyId: fixtures.second.id }, { liked: true }, null, []]) {
        const denied = await change(id, jars[0], true, { body }); assert.equal(denied.status, 400); privateHeaders(denied);
      }
      assert.equal((await change(id, jars[0], true, { rawBody: "{", headers: { "content-type": "application/json" } })).status, 400);
      assert.equal((await change(id, jars[0], true, { rawBody: "{}", body: undefined, headers: { "content-type": "text/plain" } })).status, 415);
      assert.equal((await change(id, jars[0], true, { rawBody: " ".repeat(20_000) + "{}", headers: { "content-type": "application/json" } })).status, 413);
      for (const requestOrigin of [null, "null", "https://attacker.invalid"]) for (const liked of [true, false]) {
        const denied = await change(id, jars[0], liked, { requestOrigin }); assert.equal(denied.status, 403); privateHeaders(denied);
      }
      assertLikes(await change(id, jars[0], true, { headers: { "x-user-id": other, "x-role": "admin" } }), { count: 1, liked: true });
      assertLikes(await request(likePath(id), { jar: jars[1] }), { count: 1, liked: false });
      assertLikes(await change(id, jars[0], false), { count: 0, liked: false });
    });
    await check("nonpublic writes reveal neither private content nor a different deletion contract", async () => {
      for (const storyId of ["not-a-story", "11111111-1111-4111-8111-11111111111z", randomUUID(), fixtures.draft.id, fixtures.withdrawn.id]) for (const liked of [true, false]) {
        const denied = await change(storyId, jars[0], liked); assert.equal(denied.status, 404);
        assert.deepEqual(denied.data, { code: "LIKES_NOT_FOUND" }); privateHeaders(denied);
      }
      for (const path of ["/api/stories", `/api/stories/${id}`, `/api/stories/by-slug/${fixtures.first.slug}`]) {
        const response = await request(path); assert.equal(response.status, 200);
        for (const canary of fixtures.privateCanaries) assert.ok(!response.text.includes(canary));
      }
    });
    await check("the actual likes quota returns 429 with Retry-After, no mutation and readable public counts", async () => {
      // This check begins with empty limiter tables in this owned database. One
      // real mutation creates exactly this route's global and client buckets.
      assertLikes(await change(id, jars[0], true), { count: 1, liked: true });
      const buckets = (await owner.query('SELECT "key","count" FROM "AuthRateLimit"')).rows;
      assert.equal(buckets.length, 2); assert.ok(buckets.every(bucket => bucket.count === 1));
      // consumeAuthLimit currently permits 3000 non-authentication requests in
      // its global window. Advance only the two just-created synthetic buckets;
      // do not send thousands of requests or modify an application policy.
      await owner.query('UPDATE "AuthRateLimit" SET "count"=3000');
      const before = (await owner.query("SELECT * FROM story_like WHERE story_id=$1 ORDER BY user_id", [id])).rows;
      for (const [jar, liked] of [[jars[0], false], [jars[1], true]]) {
        const denied = await change(id, jar, liked);
        assert.equal(denied.status, 429); assert.deepEqual(denied.data, { code: "LIKES_RATE_LIMITED" });
        assert.match(denied.headers["retry-after"] ?? "", /^[1-9][0-9]*$/); privateHeaders(denied);
      }
      assert.deepEqual((await owner.query("SELECT * FROM story_like WHERE story_id=$1 ORDER BY user_id", [id])).rows, before);
      assertLikes(await request(likePath(id)), { count: 1, liked: false });
      assertLikes(await request(likePath(id), { jar: jars[0] }), { count: 1, liked: true });
      assertLikes(await request(likePath(id), { jar: jars[1] }), { count: 1, liked: false });
      await owner.query('DELETE FROM "AuthRateLimit"');
      assertLikes(await change(id, jars[0], false), { count: 0, liked: false });
    });
    await check("expired, revoked and logged-out sessions cannot write or retain personalized state", async () => {
      assertLikes(await change(id, jars[0], true), { count: 1, liked: true });
      const user = (await owner.query('SELECT id FROM "User" WHERE username=$1', [accounts[0].username])).rows[0];
      await owner.query('UPDATE "Session" SET "expiresAt"=CURRENT_TIMESTAMP-INTERVAL \'1 minute\' WHERE "userId"=$1', [user.id]);
      assert.equal((await change(id, jars[0], false)).status, 401);
      assertLikes(await request(likePath(id), { jar: jars[0] }), { count: 1, liked: false });
      await login(0); assertLikes(await request(likePath(id), { jar: jars[0] }), { count: 1, liked: true });
      await owner.query('DELETE FROM "Session" WHERE "userId"=$1', [user.id]);
      assert.equal((await change(id, jars[0], false)).status, 401);
      await login(0);
      const stale = { ...jars[0] };
      assert.equal((await request("/api/auth/sign-out", { method: "POST", body: {}, jar: jars[0] })).status, 200);
      assert.equal((await change(id, stale, false)).status, 401);
      await login(0); assertLikes(await change(id, jars[0], false), { count: 0, liked: false });
    });
    await check("withdraw and restore retain the count while all unavailable reads and writes return 404", async () => {
      assertLikes(await change(id, jars[0], true), { count: 1, liked: true });
      let story = await trusted.story.findUniqueOrThrow({ where: { id } });
      story = await lifecycle.withdraw({ storyId: id, expectedVersion: story.version });
      assert.equal((await request(likePath(id))).status, 404);
      for (const liked of [true, false]) assert.equal((await change(id, jars[0], liked)).status, 404);
      await lifecycle.restore({ storyId: id, expectedVersion: story.version });
      assertLikes(await request(likePath(id), { jar: jars[0] }), { count: 1, liked: true });
    });
    await check("a real production process restart and new login retain PostgreSQL state", async () => {
      await restartServer();
      assertLikes(await request(likePath(id)), { count: 1, liked: false });
      await login(0); assertLikes(await request(likePath(id), { jar: jars[0] }), { count: 1, liked: true });
      assertLikes(await change(id, jars[0], false), { count: 0, liked: false });
    });
    await check("actual database privilege failure is redacted and never reported as count zero", async () => {
      await owner.query(`REVOKE SELECT ON story_like FROM "${runtimeRole}"`);
      try {
        for (const options of [{}, { method: "PUT", body: {}, jar: jars[0] }]) {
          const failed = await request(likePath(id), options); assert.equal(failed.status, 503);
          assert.deepEqual(failed.data, { code: "LIKES_UNAVAILABLE" }); privateHeaders(failed);
        }
      } finally { await owner.query(`GRANT SELECT ON story_like TO "${runtimeRole}"`); }
      assertLikes(await request(likePath(id)), { count: 0, liked: false });
    });
    if (ca) await check("certificate-verified TLS uses secure cookies and rejects direct backend writes", async () => {
      for (const headers of [{}, { "x-mq-proxy-key": "untrusted", "x-mq-client-ip": "203.0.113.1" }]) {
        const response = await globalThis.fetch(`${backendOrigin}${likePath(id)}`, { method: "PUT",
          headers: { ...headers, "content-type": "application/json", origin, cookie: jars[0].cookie }, body: "{}" });
        assert.equal(response.status, 403);
      }
      assertLikes(await change(id, jars[0], true, { headers: { "x-mq-proxy-key": "client-supplied", "x-mq-client-ip": "malformed,client" } }), { count: 1, liked: true });
      assertLikes(await change(id, jars[0], false), { count: 0, liked: false });
    });
    return { passed, total: ca ? 11 : 10, fixtures, accounts, secrets };
  } catch (error) {
    const location = error.stack?.split("\n").filter(line => line.trim().startsWith("at ") && /scripts[\\/]likes[\\/]/.test(line)).slice(0, 3);
    console.error(`Likes HTTP diagnostic: ${JSON.stringify({ ...lastHttp, location,
      actual: typeof error.actual === "number" || typeof error.actual === "boolean" ? error.actual : undefined,
      expected: typeof error.expected === "number" || typeof error.expected === "boolean" ? error.expected : undefined })}`);
    error.likesStage = stage; throw error;
  }
  finally { await Promise.allSettled([owner.end(), trusted.$disconnect()]); }
}
