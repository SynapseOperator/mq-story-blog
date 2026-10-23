import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";

const { fetch, Headers, AbortSignal } = globalThis;
const expect = (condition, message) => assert.ok(condition, message);

/**
 * End-to-end HTTP assertions against two real production Next.js processes.
 * The caller must own the guarded temporary PostgreSQL database. This function
 * never loads a development URL or persists passwords/cookies/test responses.
 */
export async function runAuthHttpTests({ connectionString, origin, secondOrigin }) {
  const target = new URL(connectionString);
  if (!/^\/mq_test_auth_[a-f0-9]{32}$/.test(target.pathname)
    || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
    || target.username !== "mq_test") throw new Error("Refusing an unowned authentication test database");
  for (const value of [origin, secondOrigin]) {
    const server = new URL(value);
    if (server.protocol !== "http:" || server.hostname !== "127.0.0.1") throw new Error("HTTP harness permits only isolated loopback origins");
  }
  const pool = new pg.Pool({ connectionString, max: 12, connectionTimeoutMillis: 5000 });
  const suffix = randomBytes(5).toString("hex");
  const password = `Mq!${randomBytes(24).toString("base64url")}`;
  const cases = [];
  const secrets = new Set([password]);
  let primary;
  let ipCounter = 1;
  const newJar = () => new Map();
  const cookieHeader = (jar) => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  const isolatedIp = () => `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  function absorbCookies(jar, headers) {
    for (const line of headers.getSetCookie()) {
      const first = line.split(";", 1)[0];
      const separator = first.indexOf("=");
      const key = first.slice(0, separator);
      const value = first.slice(separator + 1);
      if (/max-age=0(?:;|$)/i.test(line) || !value) jar.delete(key);
      else jar.set(key, value);
    }
  }

  async function request(path, {
    method = "POST", body, jar, server = origin, requestOrigin = origin,
    contentType = "application/json", headers = {}, rawBody,
  } = {}) {
    const requestHeaders = new Headers(headers);
    // The default local configuration deliberately does not trust these headers.
    requestHeaders.set("x-forwarded-for", isolatedIp());
    requestHeaders.set("x-real-ip", isolatedIp());
    if (requestOrigin !== null) requestHeaders.set("origin", requestOrigin);
    if (method !== "GET" && contentType !== null) requestHeaders.set("content-type", contentType);
    if (jar && cookieHeader(jar)) requestHeaders.set("cookie", cookieHeader(jar));
    const response = await fetch(`${server}/api/auth${path}`, {
      method, headers: requestHeaders, redirect: "manual", signal: AbortSignal.timeout(30_000),
      body: method === "GET" ? undefined : (rawBody ?? (body === undefined ? undefined : JSON.stringify(body))),
    });
    const cookieLines = response.headers.getSetCookie();
    if (jar) absorbCookies(jar, response.headers);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    // Check every authentication response, including error/429/unknown routes.
    expect(!text.includes("@accounts.invalid"), "Public HTTP responses must not disclose internal compatibility email");
    expect(!data || typeof data !== "object" || !Object.hasOwn(data, "token"), "Public HTTP responses must not expose a raw session token");
    if (data?.session) expect(!Object.hasOwn(data.session, "token"), "Public session DTO must not contain a token");
    return { status: response.status, data, cookieLines, headers: response.headers };
  }

  async function run(name, action) {
    try {
      // The regex/identity guard above ensures these are exclusively this run's
      // temporary counters. Real application/test-instance records are untouched.
      await pool.query('DELETE FROM "RateLimit"');
      await pool.query('DELETE FROM "AuthRateLimit"');
      await action();
      cases.push({ name, passed: true });
      console.log(`PASS ${name}`);
    } catch (error) {
      // Do not print assert actual/expected objects, framework responses, stack
      // traces or driver errors: any of those can contain credentials or tokens.
      const code = /^[A-Z0-9_]{1,30}$/.test(error.code ?? "") ? error.code : "ERROR";
      cases.push({ name, passed: false });
      const reason = code === "ERR_ASSERTION" ? String(error.message).split("\n")[0] : "sensitive details withheld";
      console.log(`FAIL ${name} (${code}; ${reason})`);
    }
  }

  async function userByUsername(username) {
    return (await pool.query('SELECT * FROM "User" WHERE username = $1', [username.toLowerCase()])).rows;
  }

  async function sessionRows(account) {
    const sessions = (await pool.query('SELECT * FROM "Session" WHERE "userId" = $1 ORDER BY "createdAt", id', [account.id])).rows;
    for (const session of sessions) secrets.add(session.token);
    return sessions;
  }

  async function register(label) {
    const username = `${label}_${suffix}`;
    const jar = newJar();
    const response = await request("/sign-up/email", { body: { username, password }, jar });
    expect(response.status === 200, "Username/password-only registration must succeed");
    const rows = await userByUsername(username);
    expect(rows.length === 1, "Successful registration must create exactly one user");
    secrets.add(rows[0].email);
    const result = { username: username.toLowerCase(), id: rows[0].id, user: rows[0], jar, response };
    await sessionRows(result);
    return result;
  }

  async function expectDatabaseRejection(sql, values, expectedCode) {
    const connection = await pool.connect();
    let actualCode;
    try {
      await connection.query("BEGIN");
      try { await connection.query(sql, values); } catch (error) { actualCode = error.code; }
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
    expect(actualCode === expectedCode, "Database constraint must independently reject the invalid mutation");
  }

  async function rollbackProbe(model, label) {
    const username = `${label}_${suffix}`;
    const functionName = `auth_test_fail_${model.toLowerCase()}_${suffix}`;
    const triggerName = `auth_test_trigger_${model.toLowerCase()}_${suffix}`;
    // All identifiers and values interpolated into DDL are generated ASCII.
    await pool.query(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM "User" WHERE id = NEW."userId" AND username = '${username}') THEN RAISE EXCEPTION 'intentional authentication transaction probe'; END IF; RETURN NEW; END $$`);
    try {
      await pool.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "${model}" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
      const result = await request("/sign-up/email", { body: { username, password } });
      expect(result.status >= 400, "Intentional database failure must not return registration success");
      const counts = (await pool.query('SELECT (SELECT count(*)::int FROM "User" WHERE username = $1) AS users, (SELECT count(*)::int FROM "Account" a JOIN "User" u ON u.id = a."userId" WHERE u.username = $1) AS accounts, (SELECT count(*)::int FROM "Session" s JOIN "User" u ON u.id = s."userId" WHERE u.username = $1) AS sessions', [username])).rows[0];
      expect(Object.values(counts).every((value) => value === 0), "Registration rollback must leave no user/account/session fragments");
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON "${model}"`);
      await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  }

  try {
    const identity = (await pool.query("SELECT current_database() AS db, current_user AS usr, current_setting('server_version_num') AS version")).rows[0];
    expect(identity.db === target.pathname.slice(1) && identity.usr === "mq_test", "Database identity must match this test-owned temporary target");
    expect(Number(identity.version) >= 180000 && Number(identity.version) < 190000, "Real PostgreSQL 18 is required");

    await run("username/password-only registration creates a regular user and random internal email", async () => {
      primary = await register("primary");
      expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@accounts\.invalid$/.test(primary.user.email), "Internal email must be a UUID v4 on accounts.invalid");
      expect(!primary.user.email.includes(primary.username), "Internal email cannot derive from the username");
      expect(primary.user.emailVerified === false, "Compatibility email cannot be verified");
      expect(primary.user.name === primary.username, "Compatibility name must be server controlled");
      expect(!("role" in primary.user) || ["USER", "user"].includes(primary.user.role), "Public registration cannot elevate privileges");
      expect(Object.keys(primary.response.data.user).sort().join(",") === "id,username", "Signup must return only the safe public user DTO");
      const account = (await pool.query('SELECT password, "providerId" FROM "Account" WHERE "userId" = $1', [primary.id])).rows;
      expect(account.length === 1 && account[0].providerId === "credential", "A real credential account must exist");
      expect(typeof account[0].password === "string" && account[0].password !== password, "Password must be stored only as a salted hash");
      expect(account[0].password.includes("scrypt"), "Password must use the reviewed, versioned scrypt format");
      secrets.add(account[0].password);
    });

    await run("loopback session cookie attributes, no session cache, documented raw DB token", async () => {
      expect(Boolean(primary), "Registration prerequisite must pass");
      const cookie = primary.response.cookieLines.find((line) => /^[^=]*session_token=/i.test(line));
      expect(Boolean(cookie), "A session cookie must be issued");
      expect(/;\s*HttpOnly(?:;|$)/i.test(cookie), "Session cookie must be HttpOnly");
      expect(/;\s*SameSite=Lax(?:;|$)/i.test(cookie), "Session cookie must be SameSite=Lax");
      expect(/;\s*Path=\/(?:;|$)/i.test(cookie), "Session cookie must cover the application path");
      expect(!/;\s*Secure(?:;|$)/i.test(cookie), "Only the explicitly permitted loopback HTTP case may omit Secure; HTTPS is tested separately");
      expect(!primary.response.cookieLines.some((line) => /session_data=|account_data=/i.test(line) && !/max-age=0(?:;|$)/i.test(line)), "Cookie session cache must be disabled");
      const rows = await sessionRows(primary);
      expect(rows.length === 1, "Signup must create one database session");
      const signed = decodeURIComponent(cookie.split(";", 1)[0].split("=").slice(1).join("="));
      expect(signed.startsWith(`${rows[0].token}.`), "The framework stores the token payload in raw form, not as a database hash");
    });

    await run("both production instances read the same session through safe DTOs", async () => {
      expect(Boolean(primary), "Registration prerequisite must pass");
      for (const server of [origin, secondOrigin]) {
        const response = await request("/get-session", { method: "GET", jar: primary.jar, requestOrigin: null, server });
        expect(response.status === 200 && response.data?.user?.id === primary.id, "Both processes must resolve the database-backed session");
        expect(Object.keys(response.data.user).sort().join(",") === "id,username", "Session user DTO must be explicit and minimal");
        expect(Object.keys(response.data.session).join(",") === "expiresAt", "Session DTO must expose expiration only");
        expect(/no-store/i.test(response.headers.get("cache-control") ?? ""), "Session responses must not be cached");
      }
    });

    for (const [field, value] of [["email", `${randomUUID()}@example.invalid`], ["role", "admin"], ["admin", true], ["emailVerified", true], ["name", "Injected"], ["displayUsername", "Injected"]]) {
      await run(`registration rejects injected ${field} before database writes`, async () => {
        const username = `extra_${field.toLowerCase().slice(0, 10)}_${suffix}`;
        const result = await request("/sign-up/email", { body: { username, password, [field]: value } });
        expect(result.status >= 400 && result.status < 500, "Unexpected registration fields must return a controlled client error");
        expect((await userByUsername(username)).length === 0, "Rejected input must not insert a user");
      });
    }

    await run("case-normalized usernames identify one user on registration and login", async () => {
      const account = await register("MiXeD");
      expect(account.user.username === account.username, "Username must be stored canonically in lowercase");
      const duplicate = await request("/sign-up/email", { body: { username: account.username.toUpperCase(), password } });
      expect(duplicate.status >= 400 && duplicate.status < 500, "Case variant registration must be rejected");
      expect((await userByUsername(account.username)).length === 1, "Case variants must not create duplicate users");
      const login = await request("/sign-in/username", { body: { username: account.username.toUpperCase(), password }, jar: newJar() });
      expect(login.status === 200 && login.data?.user?.id === account.id, "Uppercase login must resolve the normalized account");
    });

    await run("login and logout cannot accept role, internal fields or a caller-selected session", async () => {
      expect(Boolean(primary), "Registration prerequisite must pass");
      const before = await sessionRows(primary);
      for (const extra of [{ role: "admin" }, { admin: true }, { emailVerified: true }, { email: `${randomUUID()}@example.invalid` }]) {
        const response = await request("/sign-in/username", { body: { username: primary.username, password, ...extra }, jar: new Map(primary.jar) });
        expect(response.status === 400, "Login must reject unapproved internal or privilege fields");
      }
      const logout = await request("/sign-out", { body: { token: "caller-selected-session" }, jar: new Map(primary.jar) });
      expect(logout.status === 400, "Logout must only target its signed cookie, never a caller-selected session token");
      const after = await sessionRows(primary);
      expect(after.length === before.length && after.every((row) => before.some((old) => old.id === row.id)), "Rejected internal fields cannot create, replace or revoke sessions");
    });

    await run("four concurrent same-name INSERTs resolve through PostgreSQL uniqueness", async () => {
      const username = `race_${suffix}`;
      const key = randomBytes(4).readUInt32BE() & 0x7fffffff;
      const functionName = `auth_test_race_${suffix}`;
      const triggerName = `auth_test_gate_${suffix}`;
      const gate = await pool.connect();
      let pending = [];
      let results;
      let waiters;
      await pool.query(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.username = '${username}' THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END $$`);
      try {
        await pool.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
        await gate.query("SELECT pg_advisory_lock($1::bigint)", [key]);
        pending = Array.from({ length: 4 }, (_, index) => request("/sign-up/email", { server: index % 2 ? secondOrigin : origin, body: { username: index % 2 ? username.toUpperCase() : username, password } }));
        const deadline = Date.now() + 15_000;
        do {
          waiters = (await pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = $1::oid AND objsubid = 1 AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())", [key])).rows[0].count;
          if (waiters === 4) break;
          await delay(50);
        } while (Date.now() < deadline);
      } finally {
        await gate.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
        gate.release();
        const settled = await Promise.allSettled(pending);
        await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON "User"`);
        await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
        expect(settled.every((item) => item.status === "fulfilled"), "All concurrent HTTP requests must finish");
        results = settled.map((item) => item.value);
      }
      expect(waiters === 4, "Four real INSERT operations must reach the database barrier before it releases");
      expect(results.filter((item) => item.status === 200).length === 1, "Exactly one concurrent registration may succeed");
      expect(results.every((item) => item.status === 200 || (item.status >= 400 && item.status < 500)), "Unique-constraint losers must return controlled client errors");
      const users = await userByUsername(username);
      expect(users.length === 1, "PostgreSQL must preserve username uniqueness under a real race");
      const count = (await pool.query('SELECT count(*)::int AS count FROM "Account" WHERE "userId" = $1', [users[0].id])).rows[0].count;
      expect(count === 1, "Only one credential account may remain");
      secrets.add(users[0].email);
      await sessionRows({ id: users[0].id });
    });

    await run("database rejects noncanonical/duplicate username and mutable/verified internal email", async () => {
      expect(Boolean(primary), "Registration prerequisite must pass");
      await expectDatabaseRejection('UPDATE "User" SET username = upper(username) WHERE id = $1', [primary.id], "23514");
      await expectDatabaseRejection('INSERT INTO "User" (id, name, email, "emailVerified", username, "createdAt", "updatedAt") VALUES ($1, $2, $3, false, $4, now(), now())', [randomUUID(), primary.username, `${randomUUID()}@accounts.invalid`, primary.username], "23505");
      await expectDatabaseRejection('UPDATE "User" SET "emailVerified" = true WHERE id = $1', [primary.id], "23514");
      await expectDatabaseRejection('UPDATE "User" SET email = $1 WHERE id = $2', [`${randomUUID()}@accounts.invalid`, primary.id], "23514");
      const unchanged = await userByUsername(primary.username);
      expect(unchanged.length === 1 && unchanged[0].email === primary.user.email && !unchanged[0].emailVerified, "Rejected SQL mutations must preserve the original account");
    });

    await run("invalid usernames and password lengths fail before account creation", async () => {
      for (const body of [{ username: "ab", password }, { username: "has space", password }, { username: "x".repeat(33), password }, { username: `short_${suffix}`, password: "short" }, { username: `long_${suffix}`, password: "x".repeat(129) }]) {
        const response = await request("/sign-up/email", { body });
        expect(response.status >= 400 && response.status < 500, "Invalid registration input must fail with a client error");
      }
    });

    await run("all unapproved email, reset, update, admin and account endpoints remain unavailable", async () => {
      const paths = ["/sign-in/email", "/change-email", "/request-password-reset", "/reset-password", "/forget-password", "/send-verification-email", "/verify-email", "/update-user", "/admin/create-user", "/change-password", "/delete-user", "/list-sessions", "/revoke-session", "/sign-in/social", "/get-access-token"];
      for (const path of paths) {
        const response = await request(path, { jar: primary?.jar, body: { email: `${randomUUID()}@example.invalid`, password, role: "admin" } });
        expect(response.status === 404, "Every unapproved authentication endpoint must return 404");
      }
      const count = (await pool.query('SELECT count(*)::int AS count FROM "Verification"')).rows[0].count;
      expect(count === 0, "No email-verification/recovery workflow may produce a verification record");
    });

    await run("unsupported methods, content types, malformed JSON and oversized bodies are rejected", async () => {
      const getSignup = await request("/sign-up/email", { method: "GET" });
      expect([404, 405].includes(getSignup.status), "GET must not invoke registration");
      const postSession = await request("/get-session", { body: {} });
      expect([404, 405].includes(postSession.status), "POST must not invoke session reads");
      const form = await request("/sign-up/email", { contentType: "application/x-www-form-urlencoded", rawBody: "username=x&password=x" });
      expect([400, 415].includes(form.status), "Form submission must not bypass strict JSON input");
      const malformed = await request("/sign-up/email", { rawBody: '{"username":' });
      expect(malformed.status === 400, "Malformed JSON must be a controlled client error");
      const oversized = await request("/sign-up/email", { rawBody: " ".repeat(4097) + JSON.stringify({ username: `oversize_${suffix}`, password }) });
      expect(oversized.status === 413, "Oversized body must be rejected before authentication");
    });

    await run("canonical URL variants cannot bypass username-only registration or inject privileges", async () => {
      const injectedEmail = `${randomUUID()}@example.invalid`;
      const paths = ["/sign-up/%65mail", "/sign-up/email/", "//sign-up/email", "/sign-up%2Femail", "/sign-up/email?email=attacker%40example.invalid&role=admin"];
      for (let index = 0; index < paths.length; index += 1) {
        const username = `path${index}_${suffix}`;
        const body = { username, password, email: injectedEmail, role: "admin" };
        let response = await request(paths[index], { body });
        for (let count = 0; count < 3 && [307, 308].includes(response.status); count += 1) {
          const location = new URL(response.headers.get("location"), origin);
          expect(location.origin === origin && location.pathname.startsWith("/api/auth/"), "Canonical redirect must remain in the same authentication scope");
          response = await request(location.pathname.slice("/api/auth".length) + location.search, { body });
        }
        expect(response.status >= 400 && response.status < 500, "Alternate paths cannot accept injected internal fields");
        expect((await userByUsername(username)).length === 0, "Alternate paths must not create users");
      }
    });

    await run("wrong password and unknown username cannot authenticate", async () => {
      expect(Boolean(primary), "Registration prerequisite must pass");
      for (const body of [{ username: primary.username, password: `Wrong!${password}` }, { username: `unknown_${suffix}`, password }]) {
        const response = await request("/sign-in/username", { body, jar: newJar() });
        expect(response.status === 401, "Incorrect credentials must return a controlled authentication error");
      }
    });

    await run("fresh login rotates session identity and leaves compatibility email unchanged", async () => {
      expect(Boolean(primary), "Registration prerequisite must pass");
      const jar = newJar();
      const first = await request("/sign-in/username", { body: { username: primary.username, password }, jar });
      expect(first.status === 200, "Correct credentials must authenticate");
      const before = cookieHeader(jar);
      const second = await request("/sign-in/username", { body: { username: primary.username, password }, jar });
      expect(second.status === 200 && Boolean(before) && cookieHeader(jar) !== before, "Authentication must create a new signed session cookie");
      const rows = await sessionRows(primary);
      expect(rows.length >= 3 && new Set(rows.map((row) => row.token)).size === rows.length, "All successful logins must have distinct random database session tokens");
      expect((await userByUsername(primary.username))[0].email === primary.user.email, "Internal compatibility email must remain stable");
    });

    await run("CSRF/Origin checks block registration and logout before database writes", async () => {
      const variants = [{ requestOrigin: "https://attacker.invalid" }, { requestOrigin: null }, { requestOrigin: "null" }, { requestOrigin: `${origin}.attacker.invalid` }, { headers: { "sec-fetch-site": "cross-site" } }];
      for (let index = 0; index < variants.length; index += 1) {
        const username = `csrf${index}_${suffix}`;
        const response = await request("/sign-up/email", { body: { username, password }, ...variants[index] });
        expect([400, 403].includes(response.status), "Cross-site or absent/opaque Origin must be rejected");
        expect((await userByUsername(username)).length === 0, "CSRF rejection must occur before registration writes");
      }
      const logout = await request("/sign-out", { body: {}, jar: primary?.jar, requestOrigin: "https://attacker.invalid" });
      expect([400, 403].includes(logout.status), "Cross-site logout with a cookie must be rejected");
      const current = await request("/get-session", { method: "GET", jar: primary?.jar, requestOrigin: null });
      expect(current.data?.user?.id === primary?.id, "Rejected CSRF logout must preserve the existing session");
    });

    await run("username-login CSRF is blocked with and without an existing cookie", async () => {
      expect(Boolean(primary), "Registration prerequisite must pass");
      const before = await sessionRows(primary);
      const variants = [{ requestOrigin: "https://attacker.invalid" }, { requestOrigin: null }, { requestOrigin: "null" }, { headers: { "sec-fetch-site": "cross-site" } }];
      for (const withCookie of [false, true]) {
        for (const variant of variants) {
          const response = await request("/sign-in/username", { body: { username: primary.username, password }, jar: withCookie ? new Map(primary.jar) : newJar(), ...variant });
          expect([400, 403].includes(response.status), "Login CSRF must be rejected even without a prior session cookie");
        }
      }
      const after = await sessionRows(primary);
      expect(after.length === before.length && after.every((row) => before.some((old) => old.id === row.id)), "Rejected CSRF attempts cannot create or replace sessions");
    });

    await run("forged and tampered signed cookies cannot authenticate or create sessions", async () => {
      const account = await register("tamper");
      const entry = [...account.jar.entries()].find(([name]) => name.endsWith(".session_token"));
      expect(Boolean(entry), "A session cookie is required for the tampering probe");
      const [name, signed] = entry;
      const before = await sessionRows(account);
      const tampered = signed.slice(0, -1) + (signed.endsWith("A") ? "B" : "A");
      for (const value of [randomBytes(48).toString("base64url"), tampered]) {
        for (const server of [origin, secondOrigin]) {
          const response = await request("/get-session", { method: "GET", jar: new Map([[name, value]]), requestOrigin: null, server });
          expect(response.status === 200 && !response.data?.user, "Invented or modified cookies must not authenticate");
        }
      }
      expect((await sessionRows(account)).length === before.length, "Invalid cookies must not create database sessions");
    });

    await run("logout deletes its database session and rejects stale cookies on both processes", async () => {
      const account = await register("logout");
      const stale = new Map(account.jar);
      const response = await request("/sign-out", { jar: account.jar, body: {} });
      expect(response.status === 200, "Logout must succeed");
      expect((await sessionRows(account)).length === 0, "Logout must delete the database session");
      expect(response.cookieLines.some((line) => /session_token=/i.test(line) && /max-age=0(?:;|$)/i.test(line)), "Logout must clear the browser session cookie");
      for (const server of [origin, secondOrigin]) {
        const result = await request("/get-session", { method: "GET", jar: new Map(stale), requestOrigin: null, server });
        expect(result.status === 200 && !result.data?.user, "Copied old cookies must fail immediately after logout");
      }
    });

    await run("database revocation immediately invalidates unchanged cookies without recreation", async () => {
      const account = await register("revoke");
      await pool.query('DELETE FROM "Session" WHERE "userId" = $1', [account.id]);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = await request("/get-session", { method: "GET", jar: new Map(account.jar), requestOrigin: null, server: attempt % 2 ? secondOrigin : origin });
        expect(response.status === 200 && !response.data?.user, "Revocation must take effect immediately on every process");
      }
      expect((await sessionRows(account)).length === 0, "Repeated stale cookies must not recreate sessions");
    });

    await run("expired database sessions cannot authenticate on either process", async () => {
      const account = await register("expire");
      await pool.query('UPDATE "Session" SET "expiresAt" = now() - interval \'1 minute\' WHERE "userId" = $1', [account.id]);
      for (const server of [origin, secondOrigin]) {
        const result = await request("/get-session", { method: "GET", jar: new Map(account.jar), requestOrigin: null, server });
        expect(result.status === 200 && !result.data?.user, "Expired sessions must not authenticate");
      }
    });

    await run("Account insertion failure rolls back the entire registration", () => rollbackProbe("Account", "fail_account"));
    await run("Session insertion failure rolls back the entire registration", () => rollbackProbe("Session", "fail_session"));

    await run("single-process signup burst bounds hashing work and leaves no partial registration", async () => {
      const inputs = Array.from({ length: 20 }, (_, index) => ({ username: `busy${index}_${suffix}`, password }));
      const results = await Promise.all(inputs.map((body) => request("/sign-up/email", { body })));
      expect(results.every((item) => [200, 503].includes(item.status)), "Admitted burst requests must finish with success or controlled capacity rejection");
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const username = inputs[index].username;
        const users = await userByUsername(username);
        if (result.status === 503) {
          expect(Number(result.headers.get("retry-after")) > 0, "Capacity rejection requires a positive Retry-After");
          expect(users.length === 0, "Rejected hash work must not leave a partially registered user");
        } else {
          expect(users.length === 1, "Successful burst registration must create exactly one user");
          const counts = (await pool.query('SELECT (SELECT count(*)::int FROM "Account" WHERE "userId" = $1) AS accounts, (SELECT count(*)::int FROM "Session" WHERE "userId" = $1) AS sessions', [users[0].id])).rows[0];
          expect(counts.accounts === 1 && counts.sessions === 1, "Successful burst registration must be complete and atomic");
        }
      }
      // CPU scheduling differs between Windows and Linux CI. Deterministic queue
      // unit tests establish the hard bound; this actual HTTP burst records the
      // capacity responses observed on this host without a production test hook.
      const busy = results.filter((item) => item.status === 503).length;
      console.log(`OBSERVED signup burst: 20 requests, ${20 - busy} successful, ${busy} controlled capacity responses`);
      await pool.query('DELETE FROM "AuthRateLimit"');
      await pool.query('DELETE FROM "RateLimit"');
      await register("recovery");
    });

    await run("shared username limiter admits at most eight concurrent attempts across two processes", async () => {
      const username = `limited_${suffix}`;
      const results = await Promise.all(Array.from({ length: 12 }, (_, index) => request("/sign-in/username", { server: index % 2 ? secondOrigin : origin, body: { username: index % 2 ? username.toUpperCase() : username, password } })));
      expect(results.filter((item) => item.status === 429).length === 4, "A canonical username has a single shared eight-request allowance");
      expect(results.filter((item) => item.status !== 429).length === 8, "Exactly eight requests may pass the username limiter");
      expect(results.every((item) => [401, 429, 503].includes(item.status)), "Rate rejection or bounded hash capacity must fail in controlled states");
      expect(results.filter((item) => item.status === 429).every((item) => Number(item.headers.get("retry-after")) > 0), "Rate-limit responses require a positive Retry-After");
    });

    await run("shared client limiter ignores spoofed forwarded IP and admits twenty concurrent attempts", async () => {
      const results = await Promise.all(Array.from({ length: 40 }, (_, index) => request("/sign-in/username", { server: index % 2 ? secondOrigin : origin, body: { username: `client${index}_${suffix}`, password } })));
      expect(results.filter((item) => item.status === 429).length === 20, "One untrusted client bucket must span both processes regardless of forged headers");
      expect(results.filter((item) => item.status !== 429).length === 20, "Only twenty concurrent requests may pass the shared client limiter");
      expect(results.every((item) => [401, 429, 503].includes(item.status)), "Limiter and capacity responses must be controlled");
      const keys = (await pool.query('SELECT key FROM "AuthRateLimit"')).rows;
      expect(keys.length > 0 && keys.every((item) => !item.key.includes(suffix) && !item.key.includes("198.18.")), "Persisted limiter keys cannot expose raw usernames or client IPs");
    });

    await run("persisted limiter expiry is shared and permits the next request", async () => {
      const body = { username: `window_${suffix}`, password };
      const initial = await Promise.all(Array.from({ length: 9 }, (_, index) => request("/sign-in/username", { body, server: index % 2 ? secondOrigin : origin })));
      expect(initial.filter((item) => item.status === 429).length === 1, "The username window must first be exhausted");
      const moved = await pool.query('UPDATE "AuthRateLimit" SET "expiresAt" = now() - interval \'1 second\'');
      expect(moved.rowCount > 0, "Real persisted limiter buckets must exist before expiring them");
      const resumed = await request("/sign-in/username", { body, server: secondOrigin });
      expect(resumed.status === 401, "After database expiry the other process must permit credential validation");
    });

    const collected = await pool.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL');
    for (const row of collected.rows) secrets.add(row.value);
    return { total: cases.length, passed: cases.filter((item) => item.passed).length, cases, secrets: [...secrets] };
  } finally {
    await pool.end();
  }
}
