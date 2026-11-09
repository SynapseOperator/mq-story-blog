import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { authConfiguration, canonicalIp, clientIdentity, credentials, inspectRequest } from "../src/server/auth/policy.ts";

const env = { MQ_AUTH_ENABLED: "true", AUTH_ORIGIN: "http://127.0.0.1:3000", AUTH_ALLOW_LOCAL_HTTP: "true",
  AUTH_SECRET: randomBytes(32).toString("hex"), SESSION_STORAGE_KEY: randomBytes(32).toString("hex"),
  DATABASE_URL: "postgresql://localhost/synthetic-not-connected" };
const config = authConfiguration(env);

test("auth requires explicit enable, secret, origin and TLS except opted-in loopback", () => {
  for (const invalid of [{ MQ_AUTH_ENABLED: "false" }, { AUTH_SECRET: "short" }, { DATABASE_URL: "" },
    { AUTH_ALLOW_LOCAL_HTTP: "false" }, { AUTH_ORIGIN: "http://example.com" },
    { AUTH_ORIGIN: "https://example.com" }, { AUTH_ORIGIN: `${env.AUTH_ORIGIN}/api` }, { AUTH_ORIGIN: `${env.AUTH_ORIGIN}?x=1` }]) {
    assert.throws(() => authConfiguration({ ...env, ...invalid }));
  }
  assert.equal(config.secure, false);
  for (const key of [undefined, "short", "A".repeat(64), env.AUTH_SECRET]) {
    assert.throws(() => authConfiguration({ ...env, SESSION_STORAGE_KEY: key }));
  }
  assert.equal(authConfiguration({ ...env, AUTH_ORIGIN: "https://example.com", AUTH_PROXY_SECRET: randomBytes(32).toString("hex") }).secure, true);
});

test("credentials strictly accept exactly two fields and canonicalize usernames", () => {
  const valid = { username: "SynThetic_User", password: randomBytes(16).toString("hex") };
  assert.equal(credentials(valid).username, "synthetic_user");
  for (const value of [null, [], { ...valid, email: "supplied@example.invalid" }, { ...valid, role: "admin" },
    { ...valid, admin: true }, { ...valid, emailVerified: true }, { ...valid, username: " space " },
    { ...valid, password: "a".repeat(129) }, { ...valid, password: "a".repeat(12) + "\ud800" }]) assert.equal(credentials(value), null);
});

test("proxy address cannot be spoofed without secret and IPv6 cannot rotate interface IDs", () => {
  assert.equal(clientIdentity(new Request(env.AUTH_ORIGIN, { headers: { "x-forwarded-for": "198.51.100.1" } }), config), "local-untrusted");
  const proxyConfig = { ...config, proxySecret: randomBytes(32).toString("hex") };
  assert.equal(clientIdentity(new Request(env.AUTH_ORIGIN, { headers: { "x-mq-client-ip": "198.51.100.1" } }), proxyConfig), null);
  assert.equal(clientIdentity(new Request(env.AUTH_ORIGIN, { headers: { "x-mq-proxy-key": proxyConfig.proxySecret, "x-mq-client-ip": "198.51.100.1" } }), proxyConfig), "198.51.100.1");
  assert.equal(canonicalIp("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(canonicalIp("2001:db8:0:1::1"), canonicalIp("2001:0db8:0000:0001:abcd::3"));
  for (const value of ["1.1.1.1, 2.2.2.2", "unknown", "", "127.0.0.1:443"]) assert.equal(canonicalIp(value), null);
});

test("HTTP preflight rejects unsafe paths, origins, methods, bodies before database access", async () => {
  const request = (path, options = {}) => new Request(`${env.AUTH_ORIGIN}/api/auth${path}`, options);
  assert.equal((await inspectRequest(request("/sign-in/email"), config)).response.status, 404);
  assert.equal((await inspectRequest(request("/get-session?disableCookieCache=true"), config)).response.status, 400);
  assert.equal((await inspectRequest(request("/sign-out", { method: "GET" }), config)).response.status, 405);
  assert.equal((await inspectRequest(request("/get-session", { headers: { "sec-fetch-site": "cross-site" } }), config)).response.status, 403);
  const write = { method: "POST", headers: { origin: config.origin, "content-type": "application/json" }, body: "{}" };
  assert.equal((await inspectRequest(request("/sign-out", write), config)).path, "/sign-out");
  assert.equal((await inspectRequest(request("/sign-out", { ...write, headers: { "content-type": "application/json" } }), config)).response.status, 403);
  assert.equal((await inspectRequest(request("/sign-out", { ...write, body: "{" }), config)).response.status, 400);
  assert.equal((await inspectRequest(request("/sign-out", { ...write, body: "a".repeat(4097) }), config)).response.status, 413);
});
