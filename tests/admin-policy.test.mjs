import assert from "node:assert/strict";
import test from "node:test";
import { inspectAdminRequest, AdminAccessError } from "../src/server/admin/policy.ts";

const config = { origin: "http://127.0.0.1:3000", secret: "s".repeat(40), databaseURL: "unused", secure: false };
test("management Origin boundary also protects future unsafe methods without cookies", () => {
  assert.equal(inspectAdminRequest(new Request(`${config.origin}/admin`), config), "local-untrusted");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.throws(() => inspectAdminRequest(new Request(`${config.origin}/api/admin/future`, { method }), config),
      error => error instanceof AdminAccessError && error.code === "ADMIN_ORIGIN_REJECTED");
    assert.equal(inspectAdminRequest(new Request(`${config.origin}/api/admin/future`, {
      method, headers: { origin: config.origin },
    }), config), "local-untrusted");
  }
  for (const headers of [{ origin: "https://attacker.invalid" }, { "sec-fetch-site": "cross-site" }]) {
    assert.throws(() => inspectAdminRequest(new Request(`${config.origin}/admin`, { headers }), config));
  }
});
test("admin proxy identity requires protected ingress and never trusts role/IP assertions", () => {
  const trusted = { ...config, proxySecret: "p".repeat(40) };
  assert.throws(() => inspectAdminRequest(new Request(`${config.origin}/admin`, {
    headers: { "x-forwarded-for": "127.0.0.1", "x-admin": "true", role: "admin" },
  }), trusted), error => error.code === "ADMIN_PROXY_REJECTED");
  assert.equal(inspectAdminRequest(new Request(`${config.origin}/admin`, {
    headers: { "x-mq-proxy-key": trusted.proxySecret, "x-mq-client-ip": "192.0.2.1" },
  }), trusted), "192.0.2.1");
});
