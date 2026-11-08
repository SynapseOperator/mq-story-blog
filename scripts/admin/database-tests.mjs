import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { applyAdminDatabasePrivileges } from "./privileges.mjs";
import { sessionFixture } from "../auth/session-fixture.mjs";

/** Real PostgreSQL assertions; only the caller-owned empty temporary DB is
 * accepted. The persistent singleton and audit remain until its owner drops
 * that exact DB. Never disable triggers or delete another task's records.
 */
export async function runAdminDatabaseTests({ connectionString, runtimeUrl, maintenanceUrl }) {
  const target = new URL(connectionString);
  assert.match(target.pathname, /^\/mq_test_admin_[a-f0-9]{32}$/);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  for (const value of [runtimeUrl, maintenanceUrl]) {
    const url = new URL(value);
    assert.equal(url.hostname, target.hostname);
    assert.equal(url.port, target.port);
    assert.equal(url.pathname, target.pathname);
  }
  const owner = new pg.Pool({ connectionString, max: 4 });
  const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 3 });
  const maintenance = new pg.Pool({ connectionString: maintenanceUrl, max: 4 });
  const runtimeRole = decodeURIComponent(new URL(runtimeUrl).username);
  const maintenanceRole = decodeURIComponent(new URL(maintenanceUrl).username);
  const provision = () => applyAdminDatabasePrivileges(owner, {
    runtimeRole, maintenanceRole, expectedDatabase: target.pathname.slice(1),
  });
  const results = [];
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const accountIds = [randomUUID(), randomUUID(), randomUUID()];
  const syntheticHash = () => `synthetic-test-hash-${randomUUID()}`;
  let adminId;
  let adminAccountId;
  async function test(name, action) {
    try { await action(); results.push({ name, passed: true }); console.log(`PASS admin database: ${name}`); }
    catch (error) {
      const code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR";
      console.log(`FAIL admin database: ${name} (${code}; raw details withheld)`);
      // The driver cause may contain password/hash/row data; preserve only its fixed category.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Admin database regression failed: ${name} (${code}; raw details withheld)`);
    }
  }
  async function rejectCode(query, code) {
    const result = await query.then(() => ({ success: true }), error => ({ success: false, code: error.code }));
    if (result.success || result.code !== code) {
      const failure = new Error("Unexpected database rejection category");
      failure.code = result.success ? "UNEXPECTED_SQL_SUCCESS" : /^[A-Z0-9_]{1,30}$/.test(result.code ?? "") ? `OBSERVED_${result.code}` : "UNKNOWN_SQL_ERROR";
      throw failure;
    }
  }
  async function addUser(pool, id, accountId) {
    const name = `admin_test_${id.replaceAll("-", "").slice(0, 12)}`;
    await pool.query(`INSERT INTO public."User" (id,name,email,"updatedAt",username)
      VALUES ($1,$2,$3,now(),$2)`, [id, name, `${randomUUID()}@accounts.invalid`]);
    await pool.query(`INSERT INTO public."Account" (id,"accountId","providerId","userId",password,"updatedAt")
      VALUES ($1,$2,'credential',$2,$3,now())`, [accountId, id, syntheticHash()]);
  }
  async function addSession(userId = adminId, expired = false) {
    const id = randomUUID();
    await sessionFixture.insert(owner, { id, userId, expiresAt: new Date(Date.now() + (expired ? -1 : 1) * 3_600_000) });
    return id;
  }
  async function allowed(sessionId, userId = adminId, pool = runtime) {
    return (await pool.query("SELECT public.mq_lock_admin_access($1,$2) AS allowed", [sessionId, userId])).rows[0].allowed;
  }
  async function awaitBlocked(pid) {
    for (let i = 0; i < 100; i++) {
      if ((await owner.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.blocked) return;
      await delay(20);
    }
    throw new Error("Expected real row-lock contention was not observed");
  }
  try {
    await test("empty migrated database has no authorization or audit", async () => {
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM "AdminGrant"')).rows[0].n, 0);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM "AdminSecurityEvent"')).rows[0].n, 0);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM "User"')).rows[0].n, 0);
    });
    await test("provisioning rejects inherited PUBLIC credential or audit column writes", async () => {
      await owner.query('GRANT UPDATE (password) ON "Account" TO PUBLIC');
      try { await assert.rejects(provision, { message: "ADMIN_PRIVILEGE_SETUP_REJECTED" }); }
      finally { await owner.query('REVOKE UPDATE (password) ON "Account" FROM PUBLIC'); }
      await owner.query('GRANT INSERT (kind) ON "AdminSecurityEvent" TO PUBLIC');
      try { await assert.rejects(provision, { message: "ADMIN_PRIVILEGE_SETUP_REJECTED" }); }
      finally { await owner.query('REVOKE INSERT (kind) ON "AdminSecurityEvent" FROM PUBLIC'); }
      await provision();
    });
    await test("provisioning rejects NOINHERIT membership that would allow SET ROLE", async () => {
      assert.match(runtimeRole, /^mq_admin_rt_[a-f0-9]{32}$/);
      assert.match(maintenanceRole, /^mq_admin_mt_[a-f0-9]{32}$/);
      await owner.query(`GRANT "${maintenanceRole}" TO "${runtimeRole}"`);
      try { await assert.rejects(provision, { message: "ADMIN_PRIVILEGE_SETUP_REJECTED" }); }
      finally { await owner.query(`REVOKE "${maintenanceRole}" FROM "${runtimeRole}"`); }
      await provision();
    });
    await test("dangling administrator identity is rejected by the database foreign key", async () => {
      await rejectCode(owner.query('INSERT INTO "AdminGrant" ("userId") VALUES ($1)', [randomUUID()]), "23503");
    });
    await test("failed initialization rolls back user, credential, grant and audit together", async () => {
      const client = await maintenance.connect();
      const id = randomUUID();
      try {
        await client.query("BEGIN");
        await addUser(client, id, randomUUID());
        await client.query('INSERT INTO "AdminGrant" ("userId") VALUES ($1)', [id]);
        await client.query("ROLLBACK");
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM "User" WHERE id=$1', [id])).rows[0].n, 0);
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM "Account" WHERE "userId"=$1', [id])).rows[0].n, 0);
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM "AdminGrant"')).rows[0].n, 0);
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM "AdminSecurityEvent"')).rows[0].n, 0);
      } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
    });
    for (let i = 0; i < ids.length; i++) await addUser(owner, ids[i], accountIds[i]);
    await test("two simultaneous singleton INSERTs contend at PostgreSQL and exactly one commits", async () => {
      const first = await maintenance.connect();
      const second = await maintenance.connect();
      let pending;
      try {
        await first.query("BEGIN");
        await first.query('INSERT INTO "AdminGrant" ("userId") VALUES ($1)', [ids[0]]);
        const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        pending = second.query('INSERT INTO "AdminGrant" ("userId") VALUES ($1)', [ids[1]])
          .then(() => ({ success: true }), error => ({ success: false, code: error.code }));
        await awaitBlocked(pid);
        await first.query("COMMIT");
        assert.deepEqual(await pending, { success: false, code: "23505" });
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM "AdminGrant"')).rows[0].n, 1);
        adminId = ids[0]; adminAccountId = accountIds[0];
      } finally {
        await first.query("ROLLBACK").catch(() => {});
        if (pending) await pending;
        first.release(); second.release();
      }
    });
    await test("initial authorization is audited using database identity without credential fields", async () => {
      const rows = (await maintenance.query('SELECT kind,"userId","databaseActor" FROM "AdminSecurityEvent"')).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, "GRANTED");
      assert.equal(rows[0].userId, adminId);
      assert.equal(rows[0].databaseActor, decodeURIComponent(new URL(maintenanceUrl).username));
      const columns = (await owner.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='AdminSecurityEvent'`)).rows.map(row => row.column_name);
      assert.deepEqual(columns.sort(), ["id", "kind", "userId", "eventAt", "databaseActor"].sort());
    });
    await test("a second row ID, rebinding identity, skipped version and fake reset are rejected", async () => {
      await rejectCode(owner.query('INSERT INTO "AdminGrant" (id,"userId") VALUES (2,$1)', [ids[1]]), "23514");
      await rejectCode(owner.query('UPDATE "AdminGrant" SET "userId"=$1,version=version+1', [ids[1]]), "23514");
      await rejectCode(owner.query('UPDATE "AdminGrant" SET "revokedAt"=now(),version=version+2'), "23514");
      await rejectCode(owner.query('UPDATE "AdminGrant" SET version=version+1,"credentialVersion"="credentialVersion"+1'), "23514");
      await rejectCode(owner.query('UPDATE "AdminGrant" SET "createdAt"=now(),version=version+1'), "23514");
    });
    await test("runtime cannot mutate grants, credentials, audits, schema or maintenance identity", async () => {
      const queries = [
        ['INSERT INTO "AdminGrant" ("userId") VALUES ($1)', [ids[1]]],
        ['UPDATE "AdminGrant" SET "revokedAt"=now(),version=version+1', []],
        ['DELETE FROM "AdminGrant"', []], ['TRUNCATE "AdminGrant"', []],
        ['UPDATE "Account" SET password=$1 WHERE id=$2', [syntheticHash(), adminAccountId]],
        ['INSERT INTO "AdminSecurityEvent" (kind,"userId","databaseActor") VALUES (\'GRANTED\',$1,\'forged\')', [adminId]],
        ['CREATE TABLE public.unauthorized_admin_probe (id int)', []],
        ['CREATE TEMP TABLE unauthorized_admin_probe (id int)', []],
      ];
      for (const [query, values] of queries) await rejectCode(runtime.query(query, values), "42501");
      const role = decodeURIComponent(new URL(maintenanceUrl).username);
      assert.match(role, /^[a-z][a-z0-9_]{2,62}$/);
      await rejectCode(runtime.query(`SET ROLE "${role}"`), "42501");
    });
    await test("maintenance cannot forge audit INSERTs or grant credential-version increments", async () => {
      await rejectCode(maintenance.query('INSERT INTO "AdminSecurityEvent" (kind,"userId","databaseActor") VALUES (\'GRANTED\',$1,\'forged\')', [adminId]), "42501");
      await rejectCode(maintenance.query('UPDATE "AdminGrant" SET "credentialVersion"="credentialVersion"+1,version=version+1'), "42501");
    });
    await test("grant/audit rows cannot be deleted, truncated or rewritten even through owner DML", async () => {
      await rejectCode(owner.query('DELETE FROM "AdminGrant"'), "23514");
      await rejectCode(owner.query('TRUNCATE "AdminGrant"'), "23514");
      await rejectCode(owner.query('UPDATE "AdminSecurityEvent" SET kind=\'REVOKED\''), "23514");
      await rejectCode(owner.query('DELETE FROM "AdminSecurityEvent"'), "23514");
      await rejectCode(owner.query('TRUNCATE "AdminSecurityEvent"'), "23514");
      // PostgreSQL's immediate ON DELETE RESTRICT action reports
      // restrict_violation (23001), rather than foreign_key_violation (23503).
      await rejectCode(owner.query('DELETE FROM "User" WHERE id=$1', [adminId]), "23001");
    });
    await test("lock function checks real user, session ownership and database expiration", async () => {
      const valid = await addSession();
      const expired = await addSession(adminId, true);
      const other = await addSession(ids[1]);
      assert.equal(await allowed(valid), true);
      assert.equal(await allowed(expired), false);
      assert.equal(await allowed(randomUUID()), false);
      assert.equal(await allowed(valid, ids[1]), false);
      assert.equal(await allowed(other), false);
      assert.equal(await allowed(other, ids[1]), false);
    });
    await test("active protected transaction holds locks; revoke waits and clears all old sessions", async () => {
      const session = await addSession();
      const reader = await runtime.connect();
      const writer = await maintenance.connect();
      let pending;
      try {
        await reader.query("BEGIN");
        assert.equal(await allowed(session, adminId, reader), true);
        const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        pending = writer.query('UPDATE "AdminGrant" SET "revokedAt"=now(),version=version+1 WHERE id=1')
          .then(result => ({ success: true, count: result.rowCount }), error => ({ success: false, code: error.code }));
        await awaitBlocked(pid);
        assert.equal((await reader.query('SELECT "revokedAt" FROM "AdminGrant" WHERE id=1')).rows[0].revokedAt, null);
        await reader.query("COMMIT");
        assert.deepEqual(await pending, { success: true, count: 1 });
        assert.equal(await allowed(session), false);
        assert.equal((await owner.query('SELECT count(*)::int AS n FROM "Session" WHERE "userId"=$1', [adminId])).rows[0].n, 0);
      } finally {
        await reader.query("ROLLBACK").catch(() => {});
        if (pending) await pending;
        reader.release(); writer.release();
      }
    });
    await test("revocation preserves singleton identity and restoration requires fresh sessions", async () => {
      await rejectCode(maintenance.query('INSERT INTO "AdminGrant" ("userId") VALUES ($1)', [ids[1]]), "23505");
      await maintenance.query('UPDATE "AdminGrant" SET "revokedAt"=NULL,version=version+1 WHERE id=1');
      assert.equal(await allowed(randomUUID()), false);
      assert.equal(await allowed(await addSession()), true);
      await rejectCode(maintenance.query('UPDATE "AdminGrant" SET "revokedAt"=NULL,version=version+1 WHERE id=1'), "23514");
    });
    await test("direct maintenance password reset advances version, audits and invalidates sessions", async () => {
      const before = (await owner.query('SELECT version,"credentialVersion" FROM "AdminGrant" WHERE id=1')).rows[0];
      const session = await addSession();
      await maintenance.query('UPDATE "Account" SET password=$1,"updatedAt"=now() WHERE id=$2', [syntheticHash(), adminAccountId]);
      const after = (await owner.query('SELECT version,"credentialVersion" FROM "AdminGrant" WHERE id=1')).rows[0];
      assert.equal(after.version, before.version + 1);
      assert.equal(after.credentialVersion, before.credentialVersion + 1);
      assert.equal(await allowed(session), false);
      assert.equal((await maintenance.query('SELECT count(*)::int AS n FROM "AdminSecurityEvent" WHERE kind=\'CREDENTIAL_RESET\'')).rows[0].n, 1);
    });
    await test("password transaction rollback restores credential, version, sessions and audit", async () => {
      const before = (await owner.query('SELECT password FROM "Account" WHERE id=$1', [adminAccountId])).rows[0].password;
      const version = (await owner.query('SELECT version FROM "AdminGrant" WHERE id=1')).rows[0].version;
      const count = (await owner.query('SELECT count(*)::int AS n FROM "AdminSecurityEvent"')).rows[0].n;
      const session = await addSession();
      const client = await maintenance.connect();
      try {
        await client.query("BEGIN");
        await client.query('UPDATE "Account" SET password=$1,"updatedAt"=now() WHERE id=$2', [syntheticHash(), adminAccountId]);
        await client.query("ROLLBACK");
      } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
      assert.equal((await owner.query('SELECT password FROM "Account" WHERE id=$1', [adminAccountId])).rows[0].password, before);
      assert.equal((await owner.query('SELECT version FROM "AdminGrant" WHERE id=1')).rows[0].version, version);
      assert.equal((await owner.query('SELECT count(*)::int AS n FROM "AdminSecurityEvent"')).rows[0].n, count);
      assert.equal(await allowed(session), true);
    });
    await test("audit write failure rolls back revoke and its session deletions", async () => {
      const before = (await owner.query('SELECT version FROM "AdminGrant" WHERE id=1')).rows[0].version;
      const session = await addSession();
      await owner.query('ALTER TABLE "AdminSecurityEvent" ADD CONSTRAINT admin_test_audit_failure CHECK (kind <> \'REVOKED\') NOT VALID');
      try {
        await rejectCode(maintenance.query('UPDATE "AdminGrant" SET "revokedAt"=now(),version=version+1 WHERE id=1'), "23514");
        assert.equal((await owner.query('SELECT version FROM "AdminGrant" WHERE id=1')).rows[0].version, before);
        assert.equal(await allowed(session), true);
      } finally { await owner.query('ALTER TABLE "AdminSecurityEvent" DROP CONSTRAINT admin_test_audit_failure'); }
    });
    await test("definer entry points use a fixed trusted search path and are not PUBLIC executable", async () => {
      const functions = (await owner.query(`SELECT proname,prosecdef,proconfig,
        EXISTS (SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'mq_%admin%'`)).rows;
      assert.ok(functions.length >= 6);
      assert.ok(functions.every(fn => fn.proconfig.includes("search_path=pg_catalog") && !fn.public_execute));
      assert.equal(functions.find(fn => fn.proname === "mq_lock_admin_access").prosecdef, true);
    });
    return { passed: results.length, total: results.length };
  } finally { await Promise.allSettled([owner.end(), runtime.end(), maintenance.end()]); }
}
