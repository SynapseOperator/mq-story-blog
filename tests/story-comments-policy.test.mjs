import assert from "node:assert/strict";
import test from "node:test";
import { AdminAccessError } from "../src/server/admin/policy.ts";
import { COMMENT_BODY_LIMIT, CommentOperationError, adminCommentRead, commentId, commentIdempotencyHash,
  commentModeration, commentPage, commentSigningKey, commentSubmission, encodeCommentCursor,
  inspectCommentOrigin, inspectCommentTarget, readCommentBody, requireCommentsEnabled } from "../src/server/comments/policy.ts";

const { Request, URLSearchParams, ReadableStream, TextEncoder } = globalThis;
const id = "ABCDEF01-1111-4111-8111-111111111111";
const path = `/api/stories/${id}/comments`;
const url = `http://localhost${path}`;
const config = { origin: "http://localhost", secret: "unused", databaseURL: "unused", secure: false, proxySecret: undefined };
const rejects = code => error => error instanceof CommentOperationError && error.commentCode === code;
const input = (body, identity = "anonymous") => ({ body, identity });
const write = (body, headers = {}) => new Request(url, { method: "POST", body,
  headers: { "content-type": "application/json", ...headers }, duplex: "half" });

test("comment routes reject identity/query overrides and distinguish invalid path IDs", () => {
  assert.equal(commentId(id), id.toLowerCase());
  assert.throws(() => commentId("missing"), rejects("COMMENT_NOT_FOUND"));
  assert.equal(inspectCommentTarget(new Request(`${url}?limit=20`), path, true).get("limit"), "20");
  for (const request of [new Request(`${url}?userId=other`), new Request(`${url}/extra`),
    new Request(url, { headers: { "x-http-method-override": "POST" } }),
    new Request(url, { headers: { "x-method-override": "POST" } })]) {
    assert.throws(() => inspectCommentTarget(request, path, false), rejects("COMMENT_VALIDATION"));
  }
});

test("anonymous submission still requires the exact Origin and trusted proxy boundary", () => {
  assert.equal(inspectCommentOrigin(write("{}", { origin: config.origin }), config), "local-untrusted");
  for (const headers of [{}, { origin: "https://attacker.invalid" }, { origin: `${config.origin}/` },
    { origin: config.origin, "sec-fetch-site": "cross-site" }]) {
    assert.throws(() => inspectCommentOrigin(write("{}", headers), config), rejects("COMMENT_ORIGIN_REJECTED"));
  }
  assert.throws(() => inspectCommentOrigin(write("{}", { origin: config.origin,
    "x-forwarded-for": "127.0.0.1" }), { ...config, proxySecret: "trusted-ingress-secret" }), rejects("COMMENT_PROXY_REJECTED"));
});

test("comment bodies require explicit display identity and plain trimmed text without supplied authority", () => {
  assert.deepEqual(commentSubmission(input("  合成留言\n\t第二行  ")), input("合成留言\n\t第二行"));
  assert.deepEqual(commentSubmission(input("<script>literal text</script>", "account")), input("<script>literal text</script>", "account"));
  for (const value of [null, [], {}, { body: "text" }, { ...input("text"), userId: "other" },
    { ...input("text"), state: "APPROVED" }, { ...input("text"), role: "admin" },
    input("text", "admin"), input("text", true), input(5), input(" \n\t ")]) {
    assert.throws(() => commentSubmission(value), rejects("COMMENT_VALIDATION"));
  }
});

test("the 500-character limit counts Unicode code points, including 500 emoji", () => {
  assert.equal(commentSubmission(input("😀".repeat(500))).body, "😀".repeat(500));
  assert.throws(() => commentSubmission(input("😀".repeat(501))), rejects("COMMENT_VALIDATION"));
  assert.equal(commentSubmission(input("e\u0301".repeat(250))).body.length, 500);
  assert.throws(() => commentSubmission(input("e\u0301".repeat(251))), rejects("COMMENT_VALIDATION"));
  assert.equal(commentSubmission(input("  " + "字".repeat(500) + "  ")).body.length, 500);
});

test("valid newlines/tabs are preserved while unpaired surrogates and other controls fail", () => {
  assert.equal(commentSubmission(input("首行\r\n\t末行")).body, "首行\r\n\t末行");
  for (const body of ["x\ud800", "\udfffy", "x\u0000y", "x\u001by", "x\u007fy", "x\u0085y", "x\u009fy", "\u000bx"]) {
    assert.throws(() => commentSubmission(input(body)), rejects("COMMENT_VALIDATION"));
  }
});

test("only normalized UUID idempotency keys produce the stored SHA-256 digest", () => {
  const digest = commentIdempotencyHash(id);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, commentIdempotencyHash(id.toLowerCase()));
  assert.notEqual(digest, commentIdempotencyHash("00000000-0000-4000-8000-000000000000"));
  for (const key of [null, "", "arbitrary", `{${id}}`, `${id},${id}`, ` ${id}`, id.replaceAll("-", "")]) {
    assert.throws(() => commentIdempotencyHash(key), rejects("COMMENT_VALIDATION"));
  }
});

test("public pagination is bounded and a canonical createdAt/id cursor round-trips", () => {
  assert.deepEqual(commentPage(new URLSearchParams()), { limit: 20 });
  const cursor = { createdAt: "2026-11-04T12:34:56.789Z", id: id.toLowerCase() };
  const token = encodeCommentCursor(cursor);
  assert.deepEqual(commentPage(new URLSearchParams({ limit: "50", cursor: token })), { limit: 50, cursor });
  assert.equal(encodeCommentCursor(null), null);
  for (const query of ["limit=0", "limit=51", "limit=01", "limit=2&limit=3", "cursor=", "cursor=not-json", "state=PENDING", "userId=other"]) {
    assert.throws(() => commentPage(new URLSearchParams(query)), rejects("COMMENT_VALIDATION"));
  }
  for (const cursor of [{ createdAt: "2026-02-30T12:34:56.789Z", id },
    { createdAt: "2026-11-04T12:34:56Z", id }, { createdAt: "2026-11-04T12:34:56.789Z", id: "bad" },
    { createdAt: "2026-11-04T12:34:56.789Z", id, userId: "other" }]) {
    const cursorToken = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    assert.throws(() => commentPage(new URLSearchParams({ cursor: cursorToken })), rejects("COMMENT_VALIDATION"));
  }
});

test("admin listing defaults to pending and accepts only the four explicit states and story filter", () => {
  assert.deepEqual(commentPage(new URLSearchParams(), true), { limit: 20, state: "PENDING" });
  for (const state of ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"]) {
    assert.deepEqual(commentPage(new URLSearchParams({ state, storyId: id }), true), { limit: 20, state, storyId: id.toLowerCase() });
  }
  for (const query of ["state=ALL", "state=approved", "state=PENDING&state=APPROVED", "storyId=bad", "storyId="]) {
    assert.throws(() => commentPage(new URLSearchParams(query), true), rejects("COMMENT_VALIDATION"));
  }
});

test("moderation accepts one explicit action and bounded version without caller authorization", () => {
  for (const action of ["approve", "reject", "withdraw"]) {
    assert.deepEqual(commentModeration({ action, expectedVersion: 0 }), { action, expectedVersion: 0 });
  }
  for (const value of [{ action: "delete", expectedVersion: 0 }, { action: { toString: "approve" }, expectedVersion: 0 },
    { action: "approve", expectedVersion: -1 }, { action: "approve", expectedVersion: 0.1 },
    { action: "approve", expectedVersion: "0" }, { action: "approve", expectedVersion: 2_147_483_647 },
    { action: "approve", expectedVersion: 0, admin: true }, { action: "approve" }]) {
    assert.throws(() => commentModeration(value), rejects("COMMENT_VALIDATION"));
  }
});

test("admin exact reads use one UUID and cannot mix pagination, state, story or repeated keys", () => {
  assert.deepEqual(adminCommentRead(new URLSearchParams({ commentId: id })), { commentId: id.toLowerCase() });
  assert.deepEqual(adminCommentRead(new URLSearchParams()), { page: { limit: 20, state: "PENDING" } });
  for (const query of ["commentId=", "commentId=bad", ...["limit=20", "cursor=abc", "state=PENDING", `storyId=${id}`,
    `commentId=${id}`, "userId=other"].map(extra => `commentId=${id}&${extra}`)]) {
    assert.throws(() => adminCommentRead(new URLSearchParams(query)), rejects("COMMENT_VALIDATION"));
  }
  assert.throws(() => commentPage(new URLSearchParams({ commentId: id })), rejects("COMMENT_VALIDATION"));
});

test("all comment writes default off and moderation uses an independent 64-hex key", () => {
  const key = "ab".repeat(32), env = { MQ_COMMENTS_ENABLED: "true", MQ_COMMENT_SIGNING_KEY: key };
  for (const disabled of [{}, { MQ_COMMENTS_ENABLED: "false" }, { MQ_COMMENTS_ENABLED: "TRUE" }]) {
    assert.throws(() => requireCommentsEnabled(disabled), rejects("COMMENT_UNAVAILABLE"));
  }
  requireCommentsEnabled(env);
  assert.equal(commentSigningKey(env).toString("hex"), key);
  for (const field of ["AUTH_SECRET", "BETTER_AUTH_SECRET", "MQ_AUTH_SECRET", "MQ_PUBLISH_SIGNING_KEY"]) {
    assert.throws(() => commentSigningKey({ ...env, [field]: key.toUpperCase() }), rejects("COMMENT_UNAVAILABLE"));
  }
  for (const invalid of ["", "aa", "z".repeat(64)]) {
    assert.throws(() => commentSigningKey({ ...env, MQ_COMMENT_SIGNING_KEY: invalid }), rejects("COMMENT_UNAVAILABLE"));
  }
  const failure = new CommentOperationError("COMMENT_CONFLICT");
  assert.ok(failure instanceof AdminAccessError);
  assert.equal(failure.status, 409); assert.equal(failure.cause, undefined);
});

test("bounded streamed JSON accepts escaped emoji but rejects malformed UTF-8 and excess bytes", async () => {
  const escaped = `{"body":"${"\\ud83d\\ude00".repeat(500)}","identity":"anonymous"}`;
  assert.equal(commentSubmission(await readCommentBody(write(escaped))).body, "😀".repeat(500));
  for (const body of ["", "{", new Uint8Array([0xff, 0xfe])]) {
    await assert.rejects(readCommentBody(write(body)), rejects("COMMENT_VALIDATION"));
  }
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(" ".repeat(COMMENT_BODY_LIMIT)));
    controller.enqueue(new TextEncoder().encode("{}")); controller.close();
  } });
  await assert.rejects(readCommentBody(write(stream)), rejects("COMMENT_BODY_TOO_LARGE"));
  await assert.rejects(readCommentBody(write("{}", { "content-length": String(COMMENT_BODY_LIMIT + 1) })), rejects("COMMENT_BODY_TOO_LARGE"));
  await assert.rejects(readCommentBody(write("{}", { "content-type": "text/plain" })), rejects("COMMENT_JSON_REQUIRED"));
  await assert.rejects(readCommentBody(write("{}", { "content-encoding": "gzip" })), rejects("COMMENT_JSON_REQUIRED"));
});
