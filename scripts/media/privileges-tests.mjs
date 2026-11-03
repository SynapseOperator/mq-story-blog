import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applyMediaDatabasePrivileges } from "./privileges.mjs";

/** Isolated integration helper. Pools/roles belong to the caller's disposable
 * database; caller applies administrator privileges before invoking this. */
export async function runMediaPrivilegeTests({ owner, runtime, runtimeRole, expectedDatabase }) {
  assert.match(expectedDatabase, /^mq_test_[a-z_]+_[a-f0-9]{32}$/);
  assert.match(runtimeRole, /^mq_[a-z_]+_[a-f0-9]{32}$/);
  assert.equal((await owner.query("SELECT current_database() AS name")).rows[0].name, expectedDatabase);
  assert.equal((await runtime.query("SELECT current_database() AS name,current_user AS role")).rows[0].name, expectedDatabase);
  assert.equal((await runtime.query("SELECT current_user AS role")).rows[0].role, runtimeRole);
  const role = `"${runtimeRole}"`;
  let passed = 0;
  const config = { runtimeRole, expectedDatabase };
  const rejected = error => error.message === "MEDIA_PRIVILEGE_SETUP_REJECTED";
  async function denied(query) {
    const result = await query.then(() => "SUCCESS", error => error.code);
    assert.equal(result, "42501");
  }
  await applyMediaDatabasePrivileges(owner, config);
  await applyMediaDatabasePrivileges(owner, config);
  passed += 1;
  console.log("PASS media privileges: explicit setup is repeatable and grants only the media column matrix");

  const id = randomUUID();
  await runtime.query("INSERT INTO media_asset(id) VALUES($1)", [id]);
  await runtime.query(`UPDATE media_asset SET state='READY',display_mime_type='image/webp',display_width=20,display_height=10,
    display_bytes=40,display_sha256=repeat('a',64),thumbnail_mime_type='image/webp',thumbnail_width=20,thumbnail_height=10,
    thumbnail_bytes=40,thumbnail_sha256=repeat('b',64),updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [id]);
  assert.equal((await runtime.query("SELECT state FROM media_asset WHERE id=$1", [id])).rows[0].state, "READY");
  passed += 1;
  console.log("PASS media privileges: runtime can reserve and finalize server-derived metadata");

  for (const query of [
    () => runtime.query("INSERT INTO media_asset(id,storage_key) VALUES($1,$2)", [randomUUID(), randomUUID()]),
    () => runtime.query("INSERT INTO media_asset(id,state) VALUES($1,'READY')", [randomUUID()]),
    () => runtime.query("UPDATE media_asset SET storage_key=$1 WHERE id=$2", [randomUUID(), id]),
    () => runtime.query("UPDATE media_asset SET id=$1 WHERE id=$2", [randomUUID(), id]),
    () => runtime.query("UPDATE media_asset SET created_at=CURRENT_TIMESTAMP WHERE id=$1", [id]),
    () => runtime.query("DELETE FROM media_asset WHERE id=$1", [id]),
    () => runtime.query("TRUNCATE media_asset"),
    () => runtime.query("INSERT INTO story_revision_asset(revision_id,asset_id) VALUES($1,$2)", [randomUUID(), id]),
    () => runtime.query("UPDATE story SET state='PUBLISHED' WHERE false"),
    () => runtime.query("UPDATE story SET published_revision_id=NULL WHERE false"),
    () => runtime.query("UPDATE \"AdminGrant\" SET \"revokedAt\"=NULL WHERE false"),
    () => runtime.query("UPDATE story_revision SET content='{}'::jsonb WHERE false"),
    () => runtime.query("SELECT public.mq_project_revision_assets()"),
  ]) await denied(query());
  passed += 1;
  console.log("PASS media privileges: real SQL cannot mutate identities, references, historical revisions or authority/publication fields");

  for (const grant of [
    { add: "GRANT UPDATE (storage_key) ON media_asset TO PUBLIC", remove: "REVOKE UPDATE (storage_key) ON media_asset FROM PUBLIC" },
    { add: "GRANT INSERT ON story_revision_asset TO PUBLIC", remove: "REVOKE INSERT ON story_revision_asset FROM PUBLIC" },
    { add: "GRANT EXECUTE ON FUNCTION public.mq_project_revision_assets() TO PUBLIC", remove: "REVOKE EXECUTE ON FUNCTION public.mq_project_revision_assets() FROM PUBLIC" },
  ]) {
    await owner.query(grant.add);
    try { await assert.rejects(applyMediaDatabasePrivileges(owner, config), rejected); }
    finally { await owner.query(grant.remove); }
  }
  assert.equal((await runtime.query("SELECT has_column_privilege(current_user,'media_asset','storage_key','UPDATE') AS allowed")).rows[0].allowed, false);
  passed += 1;
  console.log("PASS media privileges: PUBLIC column, relation and function escalation rejects and rolls back provisioning");

  await owner.query(`GRANT UPDATE (published_revision_id) ON story TO ${role}`);
  try { await assert.rejects(applyMediaDatabasePrivileges(owner, config), rejected); }
  finally { await owner.query(`REVOKE UPDATE (published_revision_id) ON story FROM ${role}`); }
  passed += 1;
  console.log("PASS media privileges: existing unsafe publication access cannot be disguised by media grants");

  const otherDatabase = expectedDatabase.slice(0, -1) + (expectedDatabase.endsWith("0") ? "1" : "0");
  await assert.rejects(applyMediaDatabasePrivileges(owner, { runtimeRole, expectedDatabase: otherDatabase }), rejected);
  await applyMediaDatabasePrivileges(owner, config);
  assert.equal((await runtime.query("SELECT state FROM media_asset WHERE id=$1", [id])).rows[0].state, "READY");
  passed += 1;
  console.log("PASS media privileges: target mismatch refuses provisioning; correct target recovers without changing data");
  return { passed, total: 6 };
}
