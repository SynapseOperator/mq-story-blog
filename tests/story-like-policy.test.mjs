import assert from "node:assert/strict";
import test from "node:test";
import { LIKE_BODY_LIMIT, LikeOperationError, inspectLikeOrigin, inspectLikeTarget, readLikeBody } from "../src/server/likes/policy.ts";
import { assertLikePrivilegeRows } from "../src/server/likes/privileges.ts";
const { Request, ReadableStream, TextEncoder } = globalThis;
const id = "11111111-1111-4111-8111-111111111111";
const url = `http://localhost/api/stories/${id}/likes`;
const config = { origin: "http://localhost", secret: "unused", databaseURL: "unused", secure: false, proxySecret: undefined };
const rejects = code => error => error instanceof LikeOperationError && error.code === code;
const write = (body, headers = {}) => new Request(url, { method: "PUT", body, headers: { "content-type": "application/json", ...headers }, duplex: "half" });

test("likes accept only the exact story endpoint without method/query overrides", () => {
  inspectLikeTarget(new Request(url), id);
  for (const request of [new Request(`${url}?userId=other`), new Request(`${url}/extra`),
    new Request(url, { headers: { "x-http-method-override": "DELETE" } }),
    new Request(url, { headers: { "x-method-override": "PUT" } })]) {
    assert.throws(() => inspectLikeTarget(request, id), rejects("LIKES_VALIDATION"));
  }
  assert.throws(() => inspectLikeTarget(new Request(url), "not-a-story"), rejects("LIKES_NOT_FOUND"));
});

test("likes require exact Origin for both mutation methods and reject cross-site reads", () => {
  assert.equal(inspectLikeOrigin(new Request(url), config), "local-untrusted");
  for (const method of ["PUT", "DELETE"]) {
    assert.equal(inspectLikeOrigin(new Request(url, { method, headers: { origin: config.origin } }), config), "local-untrusted");
    for (const headers of [{}, { origin: "https://attacker.invalid" }, { origin: config.origin, "sec-fetch-site": "cross-site" }]) {
      assert.throws(() => inspectLikeOrigin(new Request(url, { method, headers }), config), rejects("LIKES_ORIGIN_REJECTED"));
    }
  }
  assert.throws(() => inspectLikeOrigin(new Request(url, { headers: { "sec-fetch-site": "cross-site" } }), config), rejects("LIKES_ORIGIN_REJECTED"));
  assert.throws(() => inspectLikeOrigin(new Request(url), { ...config, proxySecret: "trusted-ingress-secret" }), rejects("LIKES_PROXY_REJECTED"));
});

test("like writes only accept an empty JSON object, never a caller identity or state", async () => {
  await readLikeBody(write("{}"));
  await readLikeBody(write(" \n { } ", { "content-type": "application/json; charset=utf-8" }));
  for (const body of ["", "{", "null", "[]", "true", "0", '""', '{"userId":"other"}', '{"liked":true}', '{"count":4}', '{"role":"admin"}']) {
    await assert.rejects(readLikeBody(write(body)), rejects("LIKES_VALIDATION"));
  }
  await assert.rejects(readLikeBody(write("{}", { "content-type": "text/plain" })), rejects("LIKES_JSON_REQUIRED"));
  await assert.rejects(readLikeBody(write("{}", { "content-encoding": "gzip" })), rejects("LIKES_JSON_REQUIRED"));
});

test("like JSON validates actual streamed bytes and rejects malformed UTF-8", async () => {
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(" ".repeat(LIKE_BODY_LIMIT)));
    controller.enqueue(new TextEncoder().encode("{}")); controller.close();
  } });
  await assert.rejects(readLikeBody(write(stream)), rejects("LIKES_BODY_TOO_LARGE"));
  await assert.rejects(readLikeBody(write(new Uint8Array([0xff, 0xfe]))), rejects("LIKES_VALIDATION"));
  await assert.rejects(readLikeBody(write("{}", { "content-length": String(LIKE_BODY_LIMIT + 1) })), rejects("LIKES_BODY_TOO_LARGE"));
});

test("unsafe or unavailable runtime privilege evidence fails closed", () => {
  assertLikePrivilegeRows([{ unsafe: false }]);
  for (const rows of [[], [{ unsafe: true }], [{ unsafe: null }], [{ unsafe: false }, { unsafe: false }]]) {
    assert.throws(() => assertLikePrivilegeRows(rows), rejects("LIKES_UNAVAILABLE"));
  }
  const error = new LikeOperationError("LIKES_UNAUTHENTICATED");
  assert.equal(error.status, 401);
  assert.equal(error.cause, undefined);
});
