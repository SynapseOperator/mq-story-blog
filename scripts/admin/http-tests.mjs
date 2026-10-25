import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin, revokeAdmin, restoreAdmin, resetAdminPassword } from "../../src/server/admin/maintenance.ts";

const { fetch, AbortSignal } = globalThis;

function validateTarget(connectionString) {
  const url = new URL(connectionString);
  assert.match(url.pathname, /^\/mq_test_admin_[a-f0-9]{32}$/);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.username, "mq_test");
}

// Only values in memory. No HAR, cookies, request bodies, response dumps or
// error objects are persisted, including on a failing assertion.
function transport(origin, secrets, ca) {
  const parsed = new URL(origin);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.ok(parsed.protocol === "http:" || (parsed.protocol === "https:" && ca));
  return async function request(path, { method = "GET", body, jar, requestOrigin = origin, headers = {} } = {}) {
    const sent = { ...headers };
    if (requestOrigin !== null) sent.origin = requestOrigin;
    if (body !== undefined) sent["content-type"] = "application/json";
    if (jar?.cookie) sent.cookie = jar.cookie;
    const client = parsed.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const outgoing = client.request(new URL(path, origin), { method, ca, headers: sent, timeout: 30_000 }, incoming => {
        let text = "";
        incoming.setEncoding("utf8");
        incoming.on("data", chunk => { text += chunk; });
        incoming.on("error", reject);
        incoming.on("end", () => {
          try {
            assert.ok(!text.includes("@accounts.invalid"), "Internal email cannot enter an HTTP response");
            assert.ok(!/"(?:token|email|emailVerified|password)"\s*:/.test(text), "Sensitive fields cannot enter an HTTP response");
            assert.ok([...secrets].every(secret => !secret || !text.includes(secret)), "Synthetic secret cannot enter an HTTP response");
            let data = null;
            try { data = JSON.parse(text); } catch { /* The protected HTML entry is intentionally not JSON. */ }
            const cookieLines = incoming.headers["set-cookie"] ?? [];
            if (jar) {
              for (const line of cookieLines) {
                if (!/^(?:__Secure-)?mq\.session_token=/.test(line)) continue;
                jar.cookie = /max-age=0(?:;|$)/i.test(line) ? "" : line.split(";", 1)[0];
              }
            }
            resolve({ status: incoming.statusCode, data, text, headers: incoming.headers, cookieLines });
          } catch (error) { reject(error); }
        });
      });
      outgoing.once("error", reject);
      outgoing.once("timeout", () => outgoing.destroy(new Error("Isolated admin request timed out")));
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
}

export async function runAdminHttpTests({ connectionString, maintenanceUrl, runtimeRole, origin }) {
  validateTarget(connectionString);
  assert.match(runtimeRole, /^mq_admin_rt_[a-f0-9]{32}$/);
  const owner = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  const maintenance = createAuthDatabaseClient(maintenanceUrl);
  const suffix = randomBytes(5).toString("hex");
  let adminUsername = `admin_${suffix}`;
  const ordinaryUsername = `reader_${suffix}`;
  const ordinaryPassword = `MqReader!${randomBytes(24).toString("base64url")}`;
  let adminPassword = `MqAdmin!${randomBytes(24).toString("base64url")}`;
  const secrets = new Set([ordinaryPassword, adminPassword]);
  const request = transport(origin, secrets);
  let ordinaryJar = {};
  let adminJar = {};
  let grant;
  let passed = 0;
  let stage = "initialization";

  async function collectSecrets() {
    const values = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
    values.forEach(row => secrets.add(row.value));
  }
  async function run(name, fn) {
    stage = name;
    // Scope has been checked to this runner-owned disposable database.
    await owner.query('DELETE FROM "AuthRateLimit"');
    await owner.query('DELETE FROM "RateLimit"');
    await fn();
    await collectSecrets();
    passed += 1;
    console.log(`PASS admin HTTP: ${name}`);
  }
  async function login(username = adminUsername, password = adminPassword) {
    const jar = {};
    const response = await request("/api/auth/sign-in/username", { method: "POST", body: { username, password }, jar });
    assert.equal(response.status, 200, "Synthetic account must log in through the production auth route");
    assert.ok(jar.cookie, "Successful login must create a signed session cookie");
    await collectSecrets();
    return jar;
  }
  const status = jar => request("/api/admin/status", { jar });
  try {
    await run("guest direct API and HTML access is denied", async () => {
      assert.equal((await status()).status, 401);
      assert.equal((await request("/admin")).status, 401);
    });
    await run("ordinary username-only registration succeeds with the restricted runtime role", async () => {
      const registered = await request("/api/auth/sign-up/email", { method: "POST", body: { username: ordinaryUsername, password: ordinaryPassword }, jar: ordinaryJar });
      assert.equal(registered.status, 200);
      assert.ok(ordinaryJar.cookie);
      assert.equal(Number((await owner.query('SELECT count(*) FROM "AdminGrant"')).rows[0].count), 0);
    });
    await run("registration cannot inject any administrative or compatibility field", async () => {
      for (const extra of [{ role: "admin" }, { admin: true }, { adminGrant: { id: 1 } }, { permissions: ["admin"] }, { emailVerified: true }, { email: "injected@example.invalid" }]) {
        const response = await request("/api/auth/sign-up/email", { method: "POST", body: { username: `reject_${suffix}`, password: ordinaryPassword, ...extra } });
        assert.equal(response.status, 400);
      }
      assert.equal(Number((await owner.query('SELECT count(*) FROM "User"')).rows[0].count), 1);
      assert.equal(Number((await owner.query('SELECT count(*) FROM "AdminGrant"')).rows[0].count), 0);
    });
    await run("ordinary session and forged role headers cannot access the backend", async () => {
      assert.equal((await status(ordinaryJar)).status, 403);
      assert.equal((await request("/admin", { jar: ordinaryJar })).status, 403);
      assert.equal((await request("/api/admin/status", { jar: ordinaryJar, headers: { "x-role": "admin", "x-user-role": "admin", "x-admin": "true" } })).status, 403);
      assert.equal((await status({ cookie: `${ordinaryJar.cookie}; role=admin; admin=true` })).status, 403);
      assert.equal((await request("/api/admin/status?role=admin", { jar: ordinaryJar })).status, 400);
    });
    await run("public administrative mutation and framework admin endpoints do not exist", async () => {
      for (const path of ["/api/admin/grant", "/api/admin/revoke", "/api/admin/reset-password", "/api/auth/admin/create-user"]) {
        assert.equal((await request(path, { method: "POST", jar: ordinaryJar, body: { role: "admin" } })).status, 404);
      }
    });
    await run("two concurrent offline initializers have one winner and roll back the losing account", async () => {
      const candidates = [
        { username: adminUsername, password: adminPassword },
        { username: `other_${suffix}`, password: `MqOther!${randomBytes(24).toString("base64url")}` },
      ];
      secrets.add(candidates[1].password);
      const lock = randomBytes(4).readUInt32BE() % 2_000_000_000;
      const gate = await owner.connect();
      let attempts = [];
      try {
        // Both initializers must pass their initial empty-grant read and block
        // inside the User INSERT. Observing both advisory waiters proves real
        // concurrent transactions rather than Promise scheduling alone.
        await owner.query(`CREATE FUNCTION public.mq_test_admin_init_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lock}); RETURN NEW; END; $$`);
        await owner.query('CREATE TRIGGER mq_test_admin_init_gate BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION public.mq_test_admin_init_gate()');
        await gate.query("SELECT pg_advisory_lock($1)", [lock]);
        attempts = candidates.map(candidate => initializeAdmin(maintenance, candidate));
        const outcomesPromise = Promise.allSettled(attempts);
        let observed = false;
        for (let round = 0; round < 100; round += 1) {
          const waiting = (await owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock' AND wait_event='advisory'`,
          [new URL(maintenanceUrl).username])).rows[0].n;
          if (waiting >= 2) { observed = true; break; }
          await delay(20);
        }
        await gate.query("SELECT pg_advisory_unlock($1)", [lock]);
        const outcomes = await outcomesPromise;
        assert.ok(observed, "Both initializer transactions must visibly wait on the PostgreSQL barrier");
        const winners = outcomes.map((result, index) => ({ result, index })).filter(({ result }) => result.status === "fulfilled");
        assert.equal(winners.length, 1, "Exactly one distinct dedicated administrator initialization must commit");
        const winner = winners[0];
        grant = winner.result.value;
        adminUsername = candidates[winner.index].username;
        adminPassword = candidates[winner.index].password;
      } finally {
        try {
          await gate.query("SELECT pg_advisory_unlock($1)", [lock]).catch(() => {});
          await Promise.allSettled(attempts);
          await owner.query('DROP TRIGGER IF EXISTS mq_test_admin_init_gate ON "User"');
          await owner.query("DROP FUNCTION IF EXISTS public.mq_test_admin_init_gate()");
        } finally { gate.release(); }
      }
      assert.equal(grant.version, 0);
      assert.ok(grant.userId);
      assert.equal(Number((await owner.query('SELECT count(*) FROM "AdminGrant"')).rows[0].count), 1);
      assert.equal(Number((await owner.query('SELECT count(*) FROM "AdminSecurityEvent" WHERE kind = \'GRANTED\'')).rows[0].count), 1);
      assert.equal(Number((await owner.query('SELECT count(*) FROM "User"')).rows[0].count), 2);
      assert.equal(Number((await owner.query('SELECT count(*) FROM "Account"')).rows[0].count), 2);
    });
    await run("repeated initialization refuses a second account without partial records", async () => {
      await assert.rejects(initializeAdmin(maintenance, { username: `second_${suffix}`, password: adminPassword }));
      assert.equal(Number((await owner.query('SELECT count(*) FROM "User"')).rows[0].count), 2);
      assert.equal(Number((await owner.query('SELECT count(*) FROM "Account"')).rows[0].count), 2);
      assert.equal(Number((await owner.query('SELECT count(*) FROM "AdminSecurityEvent"')).rows[0].count), 1);
    });
    await run("valid dedicated administrator can use the protected API and HTML entry", async () => {
      adminJar = await login();
      const allowed = await status(adminJar);
      assert.equal(allowed.status, 200);
      assert.deepEqual(allowed.data, { authorized: true });
      assert.match(allowed.headers["cache-control"] ?? "", /(?:^|,\s*)no-store(?:,|$)/);
      const page = await request("/admin", { jar: adminJar });
      assert.equal(page.status, 200);
      assert.match(page.headers["content-type"] ?? "", /text\/html/);
      assert.match(page.text, /MQ/);
    });
    await run("forged cookies and cross-site requests are refused", async () => {
      const forged = { cookie: `${adminJar.cookie.slice(0, -1)}${adminJar.cookie.endsWith("a") ? "b" : "a"}` };
      assert.equal((await status(forged)).status, 401);
      assert.equal((await status({ cookie: "mq.session_token=administrator" })).status, 401);
      assert.equal((await request("/api/admin/status", { jar: adminJar, requestOrigin: "https://attacker.invalid" })).status, 403);
      assert.equal((await request("/admin", { jar: adminJar, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
      assert.equal((await request("/api/admin/status", { method: "POST", jar: adminJar, body: { role: "admin" } })).status, 405);
    });
    await run("expired sessions cannot retain administrative access", async () => {
      await owner.query('UPDATE "Session" SET "expiresAt" = now() - interval \'1 minute\' WHERE "userId" = $1', [grant.userId]);
      assert.equal((await status(adminJar)).status, 401);
      adminJar = await login();
      assert.equal((await status(adminJar)).status, 200);
    });
    await run("logout invalidates the copied cookie immediately", async () => {
      const previous = { ...adminJar };
      assert.equal((await request("/api/auth/sign-out", { method: "POST", jar: adminJar, body: {} })).status, 200);
      assert.equal((await status(previous)).status, 401);
      adminJar = await login();
    });
    await run("audit insertion failure rolls back revocation and session deletion", async () => {
      await owner.query("CREATE FUNCTION public.mq_test_admin_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic maintenance audit failure' USING ERRCODE = '23514'; END; $$");
      await owner.query('CREATE TRIGGER mq_test_admin_audit_failure BEFORE INSERT ON "AdminSecurityEvent" FOR EACH ROW EXECUTE FUNCTION public.mq_test_admin_audit_failure()');
      try {
        await assert.rejects(revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version }));
        const row = (await owner.query('SELECT version, "revokedAt" FROM "AdminGrant" WHERE id = 1')).rows[0];
        assert.equal(row.version, grant.version);
        assert.equal(row.revokedAt, null);
        assert.equal((await status(adminJar)).status, 200);
      } finally {
        await owner.query('DROP TRIGGER mq_test_admin_audit_failure ON "AdminSecurityEvent"');
        await owner.query("DROP FUNCTION public.mq_test_admin_audit_failure()");
      }
    });
    await run("revocation removes every old session and fresh login has no admin authority", async () => {
      const second = await login();
      grant = await revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      assert.equal((await status(adminJar)).status, 401);
      assert.equal((await status(second)).status, 401);
      adminJar = await login();
      assert.equal((await status(adminJar)).status, 403);
    });
    await run("restoration requires the same identity and never resurrects pre-restoration sessions", async () => {
      const beforeRestore = { ...adminJar };
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      assert.equal((await status(beforeRestore)).status, 401);
      adminJar = await login();
      assert.equal((await status(adminJar)).status, 200);
    });
    await run("in-flight old-password login serializes with credential reset and cannot survive it", async () => {
      const oldPassword = adminPassword;
      const replacement = `MqRace!${randomBytes(24).toString("base64url")}`;
      secrets.add(replacement);
      const lock = randomBytes(4).readUInt32BE() % 2_000_000_000;
      const gate = await owner.connect();
      let pendingLogin;
      let pendingReset;
      let resetFinished = false;
      let observedResetWait = false;
      const inFlightJar = {};
      try {
        // The Session INSERT occurs only after Better Auth has read the old
        // credential and completed its real scrypt verification. Hold it here,
        // then try reset from a separate maintenance connection.
        await owner.query(`CREATE FUNCTION public.mq_test_admin_session_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lock}); RETURN NEW; END; $$`);
        await owner.query('CREATE TRIGGER mq_test_admin_session_gate BEFORE INSERT ON "Session" FOR EACH ROW EXECUTE FUNCTION public.mq_test_admin_session_gate()');
        await gate.query("SELECT pg_advisory_lock($1)", [lock]);
        pendingLogin = request("/api/auth/sign-in/username", { method: "POST", jar: inFlightJar,
          body: { username: adminUsername, password: oldPassword } }).then(response => ({ response }), () => ({ failed: true }));
        let loginWaiting = false;
        for (let round = 0; round < 100; round += 1) {
          const n = (await owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock' AND wait_event='advisory'`, [runtimeRole])).rows[0].n;
          if (n > 0) { loginWaiting = true; break; }
          await delay(20);
        }
        assert.ok(loginWaiting, "Old-password login must reach the actual PostgreSQL Session INSERT barrier");
        pendingReset = resetAdminPassword(maintenance, { userId: grant.userId, expectedVersion: grant.version, password: replacement })
          .then(value => { resetFinished = true; return { value }; }, () => { resetFinished = true; return { failed: true }; });
        for (let round = 0; round < 100; round += 1) {
          if (resetFinished) break;
          const n = (await owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock'
              AND query LIKE '%AdminGrant%' AND cardinality(pg_blocking_pids(pid)) > 0`, [new URL(maintenanceUrl).username])).rows[0].n;
          if (n > 0) { observedResetWait = true; break; }
          await delay(20);
        }
        const resetFinishedBeforeRelease = resetFinished;
        await gate.query("SELECT pg_advisory_unlock($1)", [lock]);
        const [loggedIn, reset] = await Promise.all([pendingLogin, pendingReset]);
        assert.ok(!loggedIn.failed && loggedIn.response.status === 200, "In-flight login should finish before the waiting reset invalidates it");
        assert.ok(!reset.failed, "Concurrent controlled reset must complete");
        grant = reset.value;
        adminPassword = replacement;
        if (inFlightJar.cookie) {
          const encoded = inFlightJar.cookie.slice(inFlightJar.cookie.indexOf("=") + 1);
          secrets.add(decodeURIComponent(encoded).split(".", 1)[0]);
        }
        const staleStatus = (await status(inFlightJar)).status;
        console.log(`OBSERVED admin login/reset barrier: resetWaited=${observedResetWait}, resetCompletedBeforeLoginRelease=${resetFinishedBeforeRelease}, copiedCookieStatusAfterReset=${staleStatus}`);
        assert.ok(observedResetWait && !resetFinishedBeforeRelease, "Reset must visibly wait for the in-flight credential authentication transaction");
        assert.equal(staleStatus, 401, "Old-password in-flight login must not leave a usable session after reset commits");
      } finally {
        try {
          await gate.query("SELECT pg_advisory_unlock($1)", [lock]).catch(() => {});
          await Promise.allSettled([pendingLogin, pendingReset].filter(Boolean));
          await owner.query('DROP TRIGGER IF EXISTS mq_test_admin_session_gate ON "Session"');
          await owner.query("DROP FUNCTION IF EXISTS public.mq_test_admin_session_gate()");
        } finally { gate.release(); }
      }
      assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: { username: adminUsername, password: oldPassword } })).status, 401);
      adminJar = await login();
      assert.equal((await status(adminJar)).status, 200);
    });
    await run("credential lock timeout never delivers a successful response or session cookie", async () => {
      const lock = randomBytes(4).readUInt32BE() % 2_000_000_000;
      const gate = await owner.connect();
      let pending;
      try {
        await owner.query(`CREATE FUNCTION public.mq_test_admin_timeout_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lock}); RETURN NEW; END; $$`);
        await owner.query('CREATE TRIGGER mq_test_admin_timeout_gate BEFORE INSERT ON "Session" FOR EACH ROW EXECUTE FUNCTION public.mq_test_admin_timeout_gate()');
        await gate.query("SELECT pg_advisory_lock($1)", [lock]);
        pending = request("/api/auth/sign-in/username", { method: "POST", body: { username: adminUsername, password: adminPassword } })
          .then(response => ({ response }), () => ({ failed: true }));
        let reached = false;
        for (let round = 0; round < 100; round += 1) {
          const count = (await owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock' AND wait_event='advisory'`, [runtimeRole])).rows[0].n;
          if (count > 0) { reached = true; break; }
          await delay(20);
        }
        assert.ok(reached, "Real Session INSERT must be waiting before timeout observation");
        // Exceed the actual five-second credential-lock budget. BA uses another
        // connection; a late unissued row may exist, but no cookie may escape.
        await delay(5500);
        await gate.query("SELECT pg_advisory_unlock($1)", [lock]);
        const result = await pending;
        assert.ok(!result.failed);
        assert.equal(result.response.status, 500);
        assert.equal(result.response.data?.code, "AUTH_INTERNAL_ERROR");
        assert.equal(result.response.cookieLines.length, 0);
        console.log("OBSERVED admin credential lock timeout: AUTH_INTERNAL_ERROR, zero Set-Cookie headers");
      } finally {
        try {
          await gate.query("SELECT pg_advisory_unlock($1)", [lock]).catch(() => {});
          if (pending) await pending;
          await owner.query('DROP TRIGGER IF EXISTS mq_test_admin_timeout_gate ON "Session"');
          await owner.query("DROP FUNCTION IF EXISTS public.mq_test_admin_timeout_gate()");
        } finally { gate.release(); }
      }
      assert.equal((await status(await login())).status, 200);
    });
    await run("credential reset invalidates old password and all existing sessions atomically", async () => {
      const oldPassword = adminPassword;
      const previous = { ...adminJar };
      adminPassword = `MqReset!${randomBytes(24).toString("base64url")}`;
      secrets.add(adminPassword);
      grant = await resetAdminPassword(maintenance, { userId: grant.userId, expectedVersion: grant.version, password: adminPassword });
      assert.equal((await status(previous)).status, 401);
      const rejected = await request("/api/auth/sign-in/username", { method: "POST", body: { username: adminUsername, password: oldPassword } });
      assert.equal(rejected.status, 401);
      adminJar = await login();
      assert.equal((await status(adminJar)).status, 200);
    });
    await run("database authorization failure fails closed and recovers after privileges return", async () => {
      await owner.query(`REVOKE EXECUTE ON FUNCTION public.mq_lock_admin_access(text,text) FROM "${runtimeRole}"`);
      try {
        const failed = await status(adminJar);
        assert.equal(failed.status, 503);
        assert.equal(failed.data?.code, "ADMIN_UNAVAILABLE");
      } finally {
        await owner.query(`GRANT EXECUTE ON FUNCTION public.mq_lock_admin_access(text,text) TO "${runtimeRole}"`);
      }
      assert.equal((await status(adminJar)).status, 200);
    });
    await run("dangerous runtime credential-write privilege drift fails closed", async () => {
      await owner.query(`GRANT UPDATE (password) ON public."Account" TO "${runtimeRole}"`);
      try {
        const failed = await status(adminJar);
        assert.equal(failed.status, 503);
        assert.equal(failed.data?.code, "ADMIN_UNAVAILABLE");
      } finally {
        await owner.query(`REVOKE UPDATE (password) ON public."Account" FROM "${runtimeRole}"`);
      }
      assert.equal((await status(adminJar)).status, 200);
    });
    await run("authorizations never follow username, email or regular account state", async () => {
      ordinaryJar = await login(ordinaryUsername, ordinaryPassword);
      assert.equal((await status(ordinaryJar)).status, 403);
      const record = (await owner.query('SELECT "userId" FROM "AdminGrant" WHERE id = 1')).rows[0];
      assert.equal(record.userId, grant.userId);
      const events = (await owner.query('SELECT * FROM "AdminSecurityEvent"')).rows;
      const serialized = JSON.stringify(events);
      assert.ok(!serialized.includes("@accounts.invalid"));
      assert.ok([...secrets].every(secret => !secret || !serialized.includes(secret)));
      assert.ok(["GRANTED", "REVOKED", "RESTORED", "CREDENTIAL_RESET"].every(kind => events.some(event => event.kind === kind)));
    });
    return { passed, total: passed, secrets: [...secrets], adminUsername, adminPassword, ordinaryUsername, ordinaryPassword, grant };
  } catch {
    console.error(`Admin HTTP integration failed at: ${stage} (sensitive details withheld)`);
    throw new Error("Admin HTTP integration assertion failed");
  } finally {
    await Promise.allSettled([owner.end(), maintenance.$disconnect()]);
  }
}

export async function runAdminHttpsTests({ connectionString, origin, backendOrigin, ca, credentials, secrets }) {
  validateTarget(connectionString);
  const owner = new pg.Pool({ connectionString, max: 1 });
  const values = new Set(secrets);
  const request = transport(origin, values, ca);
  let passed = 0;
  const pass = name => { passed += 1; console.log(`PASS admin HTTPS: ${name}`); };
  const jar = {};
  try {
    await owner.query('DELETE FROM "AuthRateLimit"');
    await owner.query('DELETE FROM "RateLimit"');
    assert.equal((await request("/api/admin/status")).status, 401);
    pass("guest access remains refused through TLS ingress");
    const login = await request("/api/auth/sign-in/username", { method: "POST", jar,
      body: { username: credentials.adminUsername, password: credentials.adminPassword } });
    assert.equal(login.status, 200);
    const cookie = login.cookieLines.find(line => /^__Secure-mq\.session_token=/.test(line));
    assert.ok(cookie && /;\s*Secure(?:;|$)/i.test(cookie) && /;\s*HttpOnly(?:;|$)/i.test(cookie) && /;\s*SameSite=Lax(?:;|$)/i.test(cookie));
    assert.equal((await request("/api/admin/status", { jar })).status, 200);
    assert.equal((await request("/admin", { jar })).status, 200);
    pass("certificate-verified TLS and Secure cookie authorize the dedicated account");
    const direct = await fetch(`${backendOrigin}/api/admin/status`, { headers: { cookie: jar.cookie }, signal: AbortSignal.timeout(10_000) });
    assert.equal(direct.status, 403);
    assert.equal((await request("/api/admin/status", { jar, requestOrigin: "https://attacker.invalid" })).status, 403);
    pass("backend bypass and hostile Origin remain blocked");
    const tokens = (await owner.query('SELECT token FROM "Session"')).rows;
    tokens.forEach(row => values.add(row.token));
    const stale = { ...jar };
    assert.equal((await request("/api/auth/sign-out", { method: "POST", jar, body: {} })).status, 200);
    assert.equal((await request("/api/admin/status", { jar: stale })).status, 401);
    pass("logout invalidates a copied Secure cookie for administrator routes");
    return { passed, total: passed, secrets: [...values] };
  } finally { await owner.end(); }
}
