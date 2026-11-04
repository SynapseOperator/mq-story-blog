import assert from "node:assert/strict";
import { pathToFileURL, URL } from "node:url";
import pg from "pg";
import { LIKE_PRIVILEGE_AUDIT_SQL, assertLikePrivilegeRows } from "../../src/server/likes/privileges.ts";

/** Explicit extension of the existing restricted authentication runtime. No
 * role creation, production provisioning, startup hook or publication grants. */
export async function applyStoryLikeDatabasePrivileges(pool, { runtimeRole, expectedDatabase }) {
  assert.match(expectedDatabase ?? "", /^mq_test_admin_[a-f0-9]{32}$/, "Likes require an isolated test database");
  assert.match(runtimeRole ?? "", /^[a-z][a-z0-9_]{2,62}$/, "Invalid likes runtime identity");
  const role = `"${runtimeRole}"`;
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const context = (await connection.query("SELECT current_database() AS db,current_user AS actor")).rows[0];
    assert.equal(context.db, expectedDatabase);
    assert.notEqual(context.actor, runtimeRole);
    assert.equal((await connection.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [runtimeRole])).rows[0]?.rolcanlogin, true);
    await connection.query(`REVOKE ALL ON public.story_like FROM ${role}`);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
      await connection.query(`REVOKE ${privilege}(user_id,story_id,created_at) ON public.story_like FROM ${role}`);
    }
    await connection.query(`GRANT SELECT,DELETE ON public.story_like TO ${role}`);
    await connection.query(`GRANT INSERT(user_id,story_id) ON public.story_like TO ${role}`);
    await connection.query(`GRANT EXECUTE ON FUNCTION public.mq_lock_story_like_access(text,text,uuid) TO ${role}`);
    await connection.query(`SET LOCAL ROLE ${role}`);
    assertLikePrivilegeRows((await connection.query(LIKE_PRIVILEGE_AUDIT_SQL)).rows);
    await connection.query("RESET ROLE");
    await connection.query("COMMIT");
    return { runtimeRole, expectedDatabase, productionProvisioned: false };
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    throw new Error("LIKES_PRIVILEGE_SETUP_REJECTED");
  } finally { connection.release(); }
}

// Credentials are environment-only. The CLI is restricted to the same local,
// random test databases as the callable provisioner; it never loads .env files.
async function main() {
  const [expectedDatabase, runtimeRole, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0);
  assert.match(expectedDatabase ?? "", /^mq_test_admin_[a-f0-9]{32}$/);
  const target = new URL(process.env.MQ_LIKES_PROVISION_DATABASE_URL ?? "invalid");
  assert.ok(["postgres:", "postgresql:"].includes(target.protocol)
    && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && target.port
    && target.pathname === `/${expectedDatabase}` && target.username === "mq_test" && target.password
    && !target.search && !target.hash);
  const pool = new pg.Pool({ connectionString: target.href, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await applyStoryLikeDatabasePrivileges(pool, { runtimeRole, expectedDatabase });
    console.log("PASS isolated story-like runtime privileges; production not provisioned");
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch { console.error("LIKES_PRIVILEGE_SETUP_REJECTED; private connection details withheld."); process.exitCode = 1; }
}
