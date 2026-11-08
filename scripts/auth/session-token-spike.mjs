import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { toNodeHandler } from "better-auth/node";
import { username } from "better-auth/plugins";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { hashPassword, verifyPassword } from "../../src/server/auth/password.ts";
import { databaseUrl } from "../db/environment.mjs";
import { configureTemporaryDatabaseLogging } from "../db/log-privacy.mjs";
import { runPrisma } from "../db/prisma-command.mjs";

// Isolated experiment only. Never imported by the application. A successful
// basic login is deliberately NOT treated as proof of complete compatibility.
const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const { fetch } = globalThis;
const report = { framework: "1.7.12", candidate: "public DBAdapter wrapper over official Prisma adapter",
  deployedToApplication: false, cases: [], adapterCalls: {}, cleanup: false };
let stage = "validate isolated target";

function experimentalAdapter(db, mode, observations) {
  const factory = prismaAdapter(db, { provider: "postgresql", transaction: true });
  const storesDigest = mode === "adapter" || mode === "unsafe-prefix-adapter";
  // Deliberately unsafe counterexample, confined to this isolated Spike: a
  // prefix shortcut restores list lookups by making the stored digest a bearer.
  const queryToken = value => mode === "unsafe-prefix-adapter" && value.startsWith("sha256:") ? value : digest(value);
  return options => {
    function wrap(base) {
      const result = { ...base };
      for (const operation of ["create", "findOne", "findMany", "count", "update", "updateMany", "delete", "deleteMany", "consumeOne", "incrementOne"]) {
        result[operation] = async input => {
          if (input.model !== "session") return base[operation](input);
          report.adapterCalls[operation] = (report.adapterCalls[operation] ?? 0) + 1;
          const original = input.data?.token ?? input.update?.token
            ?? input.where?.find(item => item.field === "token" && (!item.operator || item.operator === "eq"))?.value;
          const query = storesDigest ? {
            ...input,
            ...(input.data?.token ? { data: { ...input.data, token: digest(input.data.token) } } : {}),
            ...(input.update?.token ? { update: { ...input.update, token: digest(input.update.token) } } : {}),
            ...(input.where ? { where: input.where.map(item => item.field === "token"
              ? { ...item, value: Array.isArray(item.value) ? item.value.map(queryToken) : queryToken(item.value) } : item) } : {}),
          } : input;
          const row = await base[operation](query);
          if (operation === "create" && observations.rejectNextSession) {
            observations.rejectNextSession = false;
            throw new Error("SPIKE_ROLLBACK_PROBE");
          }
          // Only an exact-token query/create has the original token available.
          // A user-ID list has no reversible mapping; leave it visible to the
          // test so the framework's list/revoke incompatibility is not hidden.
          return storesDigest && row && !Array.isArray(row) && typeof original === "string" && "token" in row
            ? { ...row, token: original } : row;
        };
      }
      if (base.transaction) result.transaction = callback => base.transaction(tx => callback(wrap(tx)));
      return result;
    }
    return wrap(factory(options));
  };
}

async function startAuth(connectionString, mode, secret, observations = {}) {
  const db = createAuthDatabaseClient(connectionString);
  let handler;
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      const status = [400, 401, 403, 429].includes(error?.statusCode) ? error.statusCode : 500;
      response.writeHead(status, { "content-type": "application/json" }); response.end('{"code":"SPIKE_EXPECTED_FAILURE"}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = betterAuth({
    baseURL: origin, secret, trustedOrigins: [origin],
    database: experimentalAdapter(db, mode, observations),
    logger: { level: "error", log: () => { observations.redactedErrors = (observations.redactedErrors ?? 0) + 1; } },
    onAPIError: { throw: true },
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 12,
      password: { hash: hashPassword, verify: verifyPassword } },
    plugins: [username()],
    // Refresh is enabled only in this experiment to probe the framework update
    // path. MQ's actual configuration keeps it disabled and remains unchanged.
    session: { expiresIn: 86400, updateAge: 3600, cookieCache: { enabled: false } },
    advanced: { cookiePrefix: "mq_spike", useSecureCookies: false,
      ipAddress: { ipAddressHeaders: [] }, defaultCookieAttributes: { httpOnly: true, sameSite: "lax" } },
    rateLimit: { enabled: true, max: 1000, window: 60, customRules: {
      "/sign-up/email": { max: 1000, window: 60 }, "/sign-in/username": { max: 1000, window: 60 },
    } },
    // Keep MQ's explicit same-origin admission, including a first username
    // login without cookies; the Username plugin alone is not that boundary.
    hooks: { before: createAuthMiddleware(async ctx => {
      if (ctx.request?.method === "POST" && ctx.request.headers.get("origin") !== origin) {
        throw new APIError("FORBIDDEN", { message: "HTTP origin required" });
      }
    }) },
    databaseHooks: { session: { create: { before: async data => {
      observations.lastGeneratedToken = data.token;
      return mode === "create-hook" ? { data: { ...data, token: digest(data.token) } } : { data };
    } } } },
  });
  handler = toNodeHandler(auth);
  return {
    db, observations, origin,
    async request(path, { method = "GET", cookie, body, badOrigin = false } = {}) {
      const response = await fetch(`${origin}/api/auth${path}`, {
        method, headers: { origin: badOrigin ? "https://outside.invalid" : origin,
          ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
      });
      const cookies = response.headers.getSetCookie();
      const sessionCookie = cookies.find(value => value.startsWith("mq_spike.session_token="))?.split(";")[0];
      return { status: response.status, body: await response.json(), cookie: sessionCookie };
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await db.$disconnect();
    },
  };
}

function tokenOf(cookie) { return decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".")[0]; }
function signedCookie(token, secret) {
  return `mq_spike.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`)}`;
}
function passed(name) { report.cases.push({ name, passed: true }); console.log(`PASS ${name}`); }

async function signup(server, label, password) {
  const name = `spike_${label}_${randomBytes(4).toString("hex")}`;
  const result = await server.request("/sign-up/email", { method: "POST", body: {
    username: name, name, email: `${randomUUID()}@accounts.invalid`, password,
  } });
  assert.equal(result.status, 200, "Synthetic framework registration succeeds");
  assert.ok(result.cookie, "Registration creates a signed session cookie");
  return { ...result, username: name };
}

async function main() {
  const version = JSON.parse(await readFile(new URL("../../node_modules/better-auth/package.json", import.meta.url), "utf8")).version;
  assert.equal(version, "1.7.12", "Reassess the Spike against any framework upgrade");
  report.sourceSha256 = Object.fromEntries(await Promise.all([
    "better-auth/dist/db/internal-adapter.mjs", "better-auth/dist/api/routes/session.mjs",
    "better-auth/dist/cookies/index.mjs", "@better-auth/prisma-adapter/dist/index.mjs",
  ].map(async file => [file, createHash("sha256")
    .update(await readFile(new URL(`../../node_modules/${file}`, import.meta.url))).digest("hex")])));
  const base = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  const name = `mq_test_auth_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^mq_test_auth_[a-f0-9]{32}$/);
  const isolated = new URL(base); isolated.pathname = `/${name}`;
  const servers = [];
  let inspection;
  let created = false;
  let poolFailed = false;
  control.on("error", () => { poolFailed = true; });
  try {
    const identity = (await control.query("SELECT current_database() db, current_user usr, current_setting('server_version_num') version")).rows[0];
    assert.equal(identity.db, "mq_test"); assert.equal(identity.usr, "mq_test");
    assert.ok(Number(identity.version) >= 180000 && Number(identity.version) < 190000);
    report.postgresVersion = identity.version;
    await control.query(`CREATE DATABASE "${name}"`); created = true;
    await configureTemporaryDatabaseLogging(control, name);
    await runPrisma(["migrate", "deploy"], isolated.href);
    inspection = new pg.Pool({ connectionString: isolated.href, max: 1, connectionTimeoutMillis: 5000 });
    inspection.on("error", () => { poolFailed = true; });
    const secret = randomBytes(32).toString("hex");
    const password = `SyntheticOnly!${randomBytes(24).toString("base64url")}`;
    const server = async (mode, key = secret, observations) => {
      const value = await startAuth(isolated.href, mode, key, observations); servers.push(value); return value;
    };
    const stored = async id => (await inspection.query('SELECT * FROM "Session" WHERE id=$1', [id])).rows[0];
    stage = "baseline token storage and signed HTTP session";
    const baseline = await server("baseline");
    const plain = await signup(baseline, "plain", password);
    const plainSession = await baseline.request("/get-session", { cookie: plain.cookie });
    const plainRow = await stored(plainSession.body.session.id);
    assert.match(tokenOf(plain.cookie), /^[A-Za-z0-9]{32}$/);
    assert.equal(plainRow.token, tokenOf(plain.cookie), "Default DB stores the exact bearer component");
    assert.equal((await baseline.request("/get-session", { cookie: `mq_spike.session_token=${encodeURIComponent(plainRow.token)}` })).body, null,
      "Database token alone is not an accepted signed cookie");
    passed("baseline raw DB token, signed cookie and real joined session read");

    stage = "baseline active-session list and cross-account revocation isolation";
    const devices = await signup(baseline, "devices", password);
    const deviceTwo = await baseline.request("/sign-in/username", { method: "POST", body: { username: devices.username, password } });
    const deviceThree = await baseline.request("/sign-in/username", { method: "POST", body: { username: devices.username, password } });
    const expiredDevice = await baseline.request("/sign-in/username", { method: "POST", body: { username: devices.username, password } });
    for (const device of [deviceTwo, deviceThree, expiredDevice]) {
      assert.equal(device.status, 200); assert.ok(device.cookie);
    }
    await inspection.query('UPDATE "Session" SET "expiresAt"=now()-interval \'1 second\' WHERE token=$1', [tokenOf(expiredDevice.cookie)]);
    const deviceList = await baseline.request("/list-sessions", { cookie: devices.cookie });
    assert.equal(deviceList.status, 200); assert.equal(deviceList.body.length, 3);
    assert.deepEqual(new Set(deviceList.body.map(item => item.token)),
      new Set([devices.cookie, deviceTwo.cookie, deviceThree.cookie].map(tokenOf)));
    assert.equal((await baseline.request("/list-sessions")).status, 401);
    assert.equal((await baseline.request("/revoke-session", { method: "POST", body: { token: tokenOf(plain.cookie) } })).status, 401);
    const foreignRevocation = await baseline.request("/revoke-session", {
      method: "POST", cookie: devices.cookie, body: { token: tokenOf(plain.cookie) },
    });
    assert.equal(foreignRevocation.status, 200);
    assert.ok((await baseline.request("/get-session", { cookie: plain.cookie })).body,
      "A successful revoke response must not be mistaken for permission to revoke another account");
    passed("baseline list excludes expired devices and cannot revoke another account");

    stage = "baseline single-session and other-device revocation";
    const selectedDevice = deviceList.body.find(item => item.token === tokenOf(deviceTwo.cookie));
    assert.equal((await baseline.request("/revoke-session", {
      method: "POST", cookie: devices.cookie, body: { token: selectedDevice.token },
    })).status, 200);
    assert.equal((await baseline.request("/get-session", { cookie: deviceTwo.cookie })).body, null);
    assert.ok((await baseline.request("/get-session", { cookie: devices.cookie })).body);
    assert.ok((await baseline.request("/get-session", { cookie: deviceThree.cookie })).body);
    assert.equal((await baseline.request("/revoke-other-sessions", { method: "POST", cookie: devices.cookie, body: {} })).status, 200);
    assert.equal((await baseline.request("/get-session", { cookie: deviceThree.cookie })).body, null);
    assert.ok((await baseline.request("/get-session", { cookie: devices.cookie })).body,
      "Revoke-other-sessions retains the calling device");
    passed("baseline list-derived single revoke and other-device revoke change actual session validity");

    stage = "baseline account-wide revocation includes the calling device";
    assert.equal((await baseline.request("/revoke-sessions", { method: "POST", cookie: devices.cookie, body: {} })).status, 200);
    assert.equal((await baseline.request("/get-session", { cookie: devices.cookie })).body, null);
    assert.ok((await baseline.request("/get-session", { cookie: plain.cookie })).body,
      "Account-wide revocation leaves unrelated accounts intact");
    passed("baseline revoke-sessions invalidates the caller and preserves unrelated accounts");

    stage = "create-hook hashing is bearer substitution, not hash-at-rest";
    const hook = await server("create-hook");
    const hooked = await signup(hook, "hook", password);
    const hookSession = await hook.request("/get-session", { cookie: hooked.cookie });
    const hookRow = await stored(hookSession.body.session.id);
    assert.equal(hookRow.token, digest(hook.observations.lastGeneratedToken));
    assert.equal(hookRow.token, tokenOf(hooked.cookie), "Hook's digest becomes the cookie bearer itself");
    passed("create-before hook stores the same value sent as cookie; no at-rest separation");

    stage = "adapter candidate login and exact-token lookup";
    const candidate = await server("adapter");
    const hashed = await signup(candidate, "adapter", password);
    const candidateSession = await candidate.request("/get-session", { cookie: hashed.cookie });
    let hashedRow = await stored(candidateSession.body.session.id);
    assert.equal(hashedRow.token, digest(tokenOf(hashed.cookie)));
    assert.notEqual(hashedRow.token, tokenOf(hashed.cookie));
    assert.equal(candidateSession.body.session.token, tokenOf(hashed.cookie));
    assert.equal((await candidate.request("/get-session", { cookie: signedCookie(hashedRow.token, secret) })).body, null,
      "Do not treat an already-hashed DB value as an accepted bearer");
    passed("adapter candidate keeps raw token out of DB and refuses digest-as-bearer");

    stage = "unsafe digest-prefix shortcut reintroduces a database bearer";
    const unsafe = await server("unsafe-prefix-adapter");
    const unsafeUser = await signup(unsafe, "unsafe", password);
    const unsafeSession = await unsafe.request("/get-session", { cookie: unsafeUser.cookie });
    const unsafeRow = await stored(unsafeSession.body.session.id);
    assert.equal(unsafeRow.token, digest(tokenOf(unsafeUser.cookie)));
    const unsafeAccepted = await unsafe.request("/get-session", { cookie: signedCookie(unsafeRow.token, secret) });
    assert.equal(unsafeAccepted.body?.user.id, unsafeRow.userId,
      "Unsafe prefix recognition makes the database digest usable when signed; never deploy this workaround");
    passed("counterexample: accepting a digest prefix loses at-rest bearer separation");

    stage = "refresh uses update by token without replacing cookie with digest";
    await inspection.query('UPDATE "Session" SET "expiresAt"=now()+interval \'2 hour\' WHERE id=$1', [hashedRow.id]);
    const refreshed = await candidate.request("/get-session", { cookie: hashed.cookie });
    assert.equal(refreshed.status, 200); assert.ok(refreshed.cookie);
    assert.equal(tokenOf(refreshed.cookie), tokenOf(hashed.cookie));
    assert.ok(new Date((await stored(hashedRow.id)).expiresAt).getTime() > Date.now() + 80000_000);
    passed("real refresh updates the hashed row and preserves cookie bearer");

    stage = "Session ID-based administrator recheck";
    await inspection.query('INSERT INTO "AdminGrant" ("userId") VALUES ($1)', [hashedRow.userId]);
    assert.equal((await candidate.request("/get-session", { cookie: hashed.cookie })).body, null,
      "Grant initialization revokes previously issued sessions");
    const afterGrant = await candidate.request("/sign-in/username", { method: "POST", body: { username: hashed.username, password } });
    assert.equal(afterGrant.status, 200); hashed.cookie = afterGrant.cookie;
    hashedRow = await stored((await candidate.request("/get-session", { cookie: hashed.cookie })).body.session.id);
    const grant = await inspection.query('SELECT public.mq_lock_admin_access($1,$2) allowed', [hashedRow.id, hashedRow.userId]);
    assert.equal(grant.rows[0].allowed, true);
    passed("existing administrator database lock accepts unchanged Session.id and userId");

    stage = "framework list and revoke compatibility limitation";
    const second = await candidate.request("/sign-in/username", { method: "POST", body: { username: hashed.username, password } });
    assert.equal(second.status, 200); assert.ok(second.cookie);
    const listed = await candidate.request("/list-sessions", { cookie: hashed.cookie });
    assert.equal(listed.status, 200); assert.equal(listed.body.length, 2);
    assert.ok(listed.body.every(item => item.token.startsWith("sha256:")));
    const other = listed.body.find(item => item.id !== hashedRow.id);
    const acknowledged = await candidate.request("/revoke-session", { method: "POST", cookie: hashed.cookie, body: { token: other.token } });
    assert.equal(acknowledged.status, 200); assert.equal(acknowledged.body.status, true);
    assert.ok((await candidate.request("/get-session", { cookie: second.cookie })).body,
      "Known incompatibility: list-derived token is double hashed and fails to revoke");
    const revokedOthers = await candidate.request("/revoke-other-sessions", { method: "POST", cookie: hashed.cookie, body: {} });
    assert.equal(revokedOthers.status, 200);
    assert.ok((await candidate.request("/get-session", { cookie: second.cookie })).body,
      "Known incompatibility: framework's bulk per-token revoke has the same mismatch");
    assert.ok((await candidate.request("/get-session", { cookie: hashed.cookie })).body);
    assert.equal((await inspection.query('SELECT count(*)::int n FROM "Session" WHERE "userId"=$1', [hashedRow.userId])).rows[0].n, 2,
      "HTTP 200 did not revoke either candidate session; the current raw token cannot match its listed digest");
    passed("reproduced list-sessions / revoke-session / revoke-other-sessions incompatibility");

    stage = "logout, expiry and ID-based server revocation";
    assert.equal((await candidate.request("/sign-out", { method: "POST", cookie: second.cookie, body: {} })).status, 200);
    assert.equal((await candidate.request("/get-session", { cookie: second.cookie })).body, null);
    await inspection.query('UPDATE "Session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [hashedRow.id]);
    assert.equal((await candidate.request("/get-session", { cookie: hashed.cookie })).body, null);
    assert.equal(await stored(hashedRow.id), undefined, "Expired session is removed using original bearer");
    const fresh = await candidate.request("/sign-in/username", { method: "POST", body: { username: hashed.username, password } });
    const freshSession = await candidate.request("/get-session", { cookie: fresh.cookie });
    await inspection.query('DELETE FROM "Session" WHERE id=$1', [freshSession.body.session.id]);
    assert.equal((await candidate.request("/get-session", { cookie: fresh.cookie })).body, null);
    passed("hashed candidate logout, expiry cleanup and server ID revocation are immediate");

    stage = "framework user-wide revocation";
    const firstBulk = await candidate.request("/sign-in/username", { method: "POST", body: { username: hashed.username, password } });
    const secondBulk = await candidate.request("/sign-in/username", { method: "POST", body: { username: hashed.username, password } });
    assert.equal((await candidate.request("/revoke-sessions", { method: "POST", cookie: firstBulk.cookie, body: {} })).status, 200);
    assert.equal((await candidate.request("/get-session", { cookie: firstBulk.cookie })).body, null);
    assert.equal((await candidate.request("/get-session", { cookie: secondBulk.cookie })).body, null);
    passed("framework revoke-sessions deletes all sessions by userId through real deleteMany");

    stage = "transaction rollback uses wrapped transaction adapter";
    const rollbackUsername = `spike_rollback_${randomBytes(4).toString("hex")}`;
    candidate.observations.rejectNextSession = true;
    const failed = await candidate.request("/sign-up/email", { method: "POST", body: {
      username: rollbackUsername, name: rollbackUsername, email: `${randomUUID()}@accounts.invalid`, password,
    } });
    assert.equal(failed.status, 500);
    assert.equal((await inspection.query('SELECT count(*)::int n FROM "User" WHERE username=$1', [rollbackUsername])).rows[0].n, 0);
    assert.equal((await inspection.query('SELECT count(*)::int n FROM "Session" WHERE token=$1', [digest(candidate.observations.lastGeneratedToken)])).rows[0].n, 0);
    passed("real signup transaction failure rolls back user, account and hashed session");

    stage = "legacy sessions cannot silently migrate by changing adapters";
    assert.equal((await candidate.request("/get-session", { cookie: plain.cookie })).body, null);
    assert.ok((await baseline.request("/get-session", { cookie: plain.cookie })).body);
    assert.equal((await inspection.query('SELECT count(*)::int n FROM "Session" WHERE id=$1', [plainRow.id])).rows[0].n, 1);
    passed("old raw sessions are rejected by candidate without rewriting or deleting history");

    stage = "database write compromise is outside signed-cookie and hash-at-rest protection";
    for (const [label, instance, transform] of [["plain", baseline, value => value], ["hashed", candidate, digest]]) {
      const attacker = await signup(instance, `writer_${label}`, password);
      const victim = await signup(instance, `target_${label}`, password);
      const writer = `mq_spike_writer_${randomBytes(12).toString("hex")}`;
      const knownToken = transform(tokenOf(attacker.cookie));
      // Simulate a compromised SQL writer, not an HTTP exploit. These are the
      // Session rights required by MQ's runtime. No AUTH_SECRET, victim cookie,
      // UPDATE, superuser privilege or access to AdminGrant is used by the role.
      await inspection.query("BEGIN");
      try {
        await inspection.query(`CREATE ROLE "${writer}" NOLOGIN NOINHERIT`);
        await inspection.query(`GRANT USAGE ON SCHEMA public TO "${writer}"`);
        await inspection.query(`GRANT SELECT, INSERT, DELETE ON public."Session" TO "${writer}"`);
        await inspection.query(`SET LOCAL ROLE "${writer}"`);
        const rights = (await inspection.query(`SELECT
          has_table_privilege(current_user, 'public."Session"', 'INSERT') AS can_insert,
          has_table_privilege(current_user, 'public."Session"', 'DELETE') AS can_delete,
          has_table_privilege(current_user, 'public."Session"', 'UPDATE') AS can_update,
          has_table_privilege(current_user, 'public."AdminGrant"', 'UPDATE') AS can_grant`)).rows[0];
        assert.deepEqual(rights, { can_insert: true, can_delete: true, can_update: false, can_grant: false });
        assert.equal((await inspection.query('DELETE FROM "Session" WHERE token=$1', [knownToken])).rowCount, 1);
        await inspection.query(`INSERT INTO "Session" (id,"userId",token,"expiresAt","updatedAt")
          VALUES ($1,$2,$3,now()+interval '24 hours',now())`, [randomUUID(), victim.body.user.id, knownToken]);
        // Remove the temporary role in the same transaction; any failure also
        // rolls back its creation. Only this random database is affected.
        await inspection.query("RESET ROLE");
        await inspection.query(`REVOKE SELECT, INSERT, DELETE ON public."Session" FROM "${writer}"`);
        await inspection.query(`REVOKE USAGE ON SCHEMA public FROM "${writer}"`);
        await inspection.query(`DROP ROLE "${writer}"`);
        await inspection.query("COMMIT");
      } catch (error) { await inspection.query("ROLLBACK"); throw error; }
      const changed = await instance.request("/get-session", { cookie: attacker.cookie });
      assert.equal(changed.body?.user.id, victim.body.user.id,
        "Neither a signed token nor its digest protects the user mapping against arbitrary database writes");
    }
    passed("counterexample: database INSERT/DELETE can rebind a signed cookie with either raw or hashed storage");

    stage = "auth secret rotation and revocation prevent old-cookie resurrection";
    const rotated = await server("baseline", randomBytes(32).toString("hex"));
    stage = "new secret rejects old cookie";
    assert.equal((await rotated.request("/get-session", { cookie: plain.cookie })).body, null);
    stage = "new secret allows fresh password login";
    const relogin = await rotated.request("/sign-in/username", { method: "POST", body: { username: plain.username, password } });
    assert.equal(relogin.status, 200); assert.ok((await rotated.request("/get-session", { cookie: relogin.cookie })).body);
    stage = "old secret rejects new cookie";
    assert.equal((await baseline.request("/get-session", { cookie: relogin.cookie })).body, null);
    stage = "revoke all and prevent secret rollback resurrection";
    await inspection.query('DELETE FROM "Session"');
    assert.equal((await baseline.request("/get-session", { cookie: plain.cookie })).body, null);
    assert.equal((await rotated.request("/get-session", { cookie: relogin.cookie })).body, null);
    stage = "cross-origin login remains rejected";
    const crossOrigin = await candidate.request("/sign-in/username", { method: "POST", badOrigin: true, body: { username: hashed.username, password } });
    assert.equal(crossOrigin.status, 403);
    passed("secret rotation rejects old signed cookies; global revoke survives secret rollback; Origin stays enforced");
    report.conclusion = "DO_NOT_DEPLOY: basic MQ paths work, full framework list/revoke semantics do not; production authentication unchanged";
    assert.equal(poolFailed, false);
  } finally {
    for (const active of servers) await active.close();
    await inspection?.end();
    if (created) {
      let drained = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const count = (await control.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1', [name])).rows[0].n;
        if (!count) { drained = true; break; }
        await delay(100);
      }
      assert.ok(drained, "SPIKE_CONNECTIONS_NOT_DRAINED");
      await control.query(`DROP DATABASE "${name}"`);
    }
    await control.end();
    report.cleanup = true;
  }
  console.log(JSON.stringify(report));
}

main().catch(() => {
  console.error(`SESSION_TOKEN_SPIKE_FAILED at ${stage}; details withheld`);
  process.exitCode = 1;
});
