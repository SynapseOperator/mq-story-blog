import assert from "node:assert/strict";
import { applyAdminDatabasePrivileges } from "../admin/privileges.mjs";
import { assertDraftPrivilegeRows, DRAFT_PRIVILEGE_AUDIT_SQL } from "../../src/server/stories/draft-privileges.ts";

/** P2-08A demonstration provisioning is deliberately limited to the isolated
 * test databases. Production identity provisioning needs its own review and
 * authorization. This is never called by server startup or an HTTP handler. */
export async function applyAdminDraftDatabasePrivileges(pool, options) {
  const { runtimeRole, expectedDatabase } = options;
  assert.match(expectedDatabase ?? "", /^mq_test_admin_[a-f0-9]{32}$/, "Draft privileges require an isolated test database");
  // Preserve the P2-05 source unchanged and start from its restricted baseline.
  // If extension setup fails, a committed read-only baseline remains fail-closed.
  await applyAdminDatabasePrivileges(pool, options);
  assert.match(runtimeRole ?? "", /^[a-z][a-z0-9_]{2,62}$/, "Invalid runtime identity");
  const role = `"${runtimeRole}"`;
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    assert.equal((await connection.query("SELECT current_database() AS db")).rows[0].db, expectedDatabase,
      "Draft provisioning target mismatch");
    await connection.query(`GRANT INSERT (id,slug,kind,draft_revision_id) ON public.story TO ${role}`);
    await connection.query(`GRANT UPDATE (draft_revision_id,version,updated_at) ON public.story TO ${role}`);
    await connection.query(`GRANT INSERT (id,story_id,title,content) ON public.story_revision TO ${role}`);
    // Evaluate actual effective rights using the runtime identity, including
    // PUBLIC grants. SET LOCAL ends at COMMIT/ROLLBACK; no role is created/altered.
    await connection.query(`SET LOCAL ROLE ${role}`);
    assertDraftPrivilegeRows((await connection.query(DRAFT_PRIVILEGE_AUDIT_SQL)).rows);
    await connection.query("RESET ROLE");
    await connection.query("COMMIT");
    return { ...options, separateIdentities: true, draftColumnPrivileges: true, productionProvisioned: false };
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    throw new Error("ADMIN_DRAFT_PRIVILEGE_SETUP_REJECTED");
  } finally { connection.release(); }
}
