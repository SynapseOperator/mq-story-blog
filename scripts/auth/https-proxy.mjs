import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const execute = promisify(execFile);
const { fetch } = globalThis;

/** A test-owned TLS ingress. No machine certificate store or TLS defaults change. */
export async function startHttpsProxy(backendPort) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, "mq-auth-tls-"));
  let proxy;
  try {
    const executable = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl";
    // OpenSSL output is captured, never relayed. The ephemeral private key stays
    // outside the repository and is removed with this exact temporary directory.
    await execute(executable, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "private.pem"),
      "-out", join(directory, "certificate.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
    { windowsHide: true, timeout: 30_000 });
    const key = await readFile(join(directory, "private.pem"));
    const ca = await readFile(join(directory, "certificate.pem"));
    const proxySecret = randomBytes(48).toString("base64url");
    proxy = https.createServer({ key, cert: ca }, (incoming, outgoing) => {
      const forwarded = http.request({
        hostname: "127.0.0.1", port: backendPort, path: incoming.url, method: incoming.method,
        headers: { ...incoming.headers, host: `127.0.0.1:${backendPort}`,
          // Overwrite, never append or trust browser-provided ingress headers.
          "x-mq-proxy-key": proxySecret, "x-mq-client-ip": incoming.socket.remoteAddress ?? "" },
      }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      forwarded.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      incoming.pipe(forwarded);
    });
    await new Promise((done, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", done);
    });
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    return {
      origin: `https://127.0.0.1:${address.port}`, ca, proxySecret,
      async close() {
        proxy.closeAllConnections();
        await new Promise((done) => proxy.close(done));
        assert.equal(dirname(resolve(directory)), parent);
        assert.match(basename(directory), /^mq-auth-tls-/);
        await rm(directory, { recursive: true });
      },
    };
  } catch {
    if (proxy?.listening) {
      proxy.closeAllConnections();
      await new Promise((done) => proxy.close(done));
    }
    assert.equal(dirname(resolve(directory)), parent);
    assert.match(basename(directory), /^mq-auth-tls-/);
    await rm(directory, { recursive: true });
    throw new Error("Test-owned HTTPS ingress could not start (OpenSSL output withheld)");
  }
}

export async function runHttpsChecks({ origin, ca, backendOrigin, connectionString }) {
  const target = new URL(connectionString);
  assert.match(target.pathname, /^\/mq_test_auth_[a-f0-9]{32}$/);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.equal(target.username, "mq_test");
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const username = `tls_${randomBytes(5).toString("hex")}`;
  const password = `MqTLS!${randomBytes(24).toString("base64url")}`;
  const secrets = [password];
  let passed = 0;
  const pass = (name) => { passed += 1; console.log(`PASS HTTPS ${name}`); };

  // Verify the actual TLS certificate using the pinned test CA. This is not an
  // HTTP call with Secure headers and does not disable TLS verification globally.
  async function request(path, { method = "POST", body, cookie, requestOrigin = origin, headers = {} } = {}) {
    return new Promise((done, reject) => {
      const outgoing = { "content-type": "application/json", ...headers };
      if (requestOrigin !== null) outgoing.origin = requestOrigin;
      if (cookie) outgoing.cookie = cookie;
      const connection = https.request(new URL(`/api/auth${path}`, origin), { method, ca, headers: outgoing, timeout: 30_000 }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("error", reject);
        response.on("end", () => {
          try {
            assert.ok(!text.includes("@accounts.invalid"), "HTTPS DTO cannot disclose internal email");
            const data = text ? JSON.parse(text) : null;
            assert.ok(!data?.token && !data?.session?.token, "HTTPS DTO cannot disclose raw session token");
            done({ status: response.statusCode, headers: response.headers, data });
          } catch (error) { reject(error); }
        });
      });
      connection.once("error", reject);
      connection.once("timeout", () => connection.destroy(new Error("Test HTTPS request timed out")));
      connection.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  try {
    await pool.query('DELETE FROM "AuthRateLimit"');
    await pool.query('DELETE FROM "RateLimit"');
    const signup = await request("/sign-up/email", { body: { username, password } });
    assert.equal(signup.status, 200, "Username-only registration must work through real HTTPS ingress");
    const user = (await pool.query('SELECT id, email FROM "User" WHERE username = $1', [username])).rows[0];
    assert.ok(user, "HTTPS registration must create a PostgreSQL user");
    secrets.push(user.email);
    pass("username-only registration over a certificate-verified TLS connection");

    const lines = signup.headers["set-cookie"] ?? [];
    const line = lines.find((value) => /^__Secure-mq\.session_token=/i.test(value));
    assert.ok(line && /;\s*Secure(?:;|$)/i.test(line) && /;\s*HttpOnly(?:;|$)/i.test(line) && /;\s*SameSite=Lax(?:;|$)/i.test(line), "HTTPS cookie must use Secure prefix, Secure, HttpOnly and SameSite=Lax");
    assert.ok(!lines.some((value) => /session_data=|account_data=/i.test(value) && !/max-age=0(?:;|$)/i.test(value)), "HTTPS sessions must not enable cookie caching");
    const cookie = line.split(";", 1)[0];
    const sessions = (await pool.query('SELECT token FROM "Session" WHERE "userId" = $1', [user.id])).rows;
    secrets.push(...sessions.map((value) => value.token));
    pass("Secure/HttpOnly/SameSite cookie attributes and disabled cookie session cache");

    const session = await request("/get-session", { method: "GET", cookie });
    assert.ok(session.status === 200 && session.data?.user?.id === user.id, "HTTPS session cookie must resolve a real account");
    pass("signed Secure cookie resolves the database-backed session");

    for (const headers of [{}, { "x-mq-proxy-key": "untrusted", "x-mq-client-ip": "203.0.113.1", "x-forwarded-for": "203.0.113.1" }]) {
      const direct = await fetch(`${backendOrigin}/api/auth/get-session`, { headers });
      assert.equal(direct.status, 403, "Direct backend requests without the authenticated proxy contract must fail closed");
    }
    const spoofed = await request("/get-session", { method: "GET", cookie,
      headers: { "x-mq-proxy-key": "client-controlled", "x-mq-client-ip": "malformed,client", "x-forwarded-for": "203.0.113.15" } });
    assert.equal(spoofed.status, 200, "Ingress must overwrite forged client headers with its own authenticated source");
    pass("direct backend requests fail closed and TLS ingress overwrites forged IP headers");

    for (const requestOrigin of [null, "null", "https://attacker.invalid"]) {
      const crossSite = await request("/sign-in/username", { body: { username, password }, requestOrigin });
      assert.equal(crossSite.status, 403, "Real HTTPS must preserve Origin checks");
    }
    pass("Origin checks stay active behind the TLS ingress");

    const logout = await request("/sign-out", { body: {}, cookie });
    assert.equal(logout.status, 200, "HTTPS logout must succeed");
    const stale = await request("/get-session", { method: "GET", cookie });
    assert.ok(stale.status === 200 && !stale.data?.user, "A stale Secure cookie must fail immediately after logout");
    const count = (await pool.query('SELECT count(*)::int AS count FROM "Session" WHERE "userId" = $1', [user.id])).rows[0].count;
    assert.equal(count, 0, "HTTPS logout must actually delete the session");
    pass("logout deletes the database session and immediately rejects the copied Secure cookie");
    return { passed, total: passed, secrets };
  } finally { await pool.end(); }
}
