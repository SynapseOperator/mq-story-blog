import assert from "node:assert/strict";

const metadata = ["display_mime_type", "display_width", "display_height", "display_bytes", "display_sha256",
  "thumbnail_mime_type", "thumbnail_width", "thumbnail_height", "thumbnail_bytes", "thumbnail_sha256"];
const identifier = value => {
  assert.match(value ?? "", /^[a-z][a-z0-9_]{2,62}$/, "Database role/target identifier is invalid");
  return `"${value}"`;
};

/** Explicit, database-scoped media privileges, after administrator provisioning.
 * Never a server-startup hook and never creates a role. Production provisioning
 * requires separately approved identities and storage/network configuration. */
export async function applyMediaDatabasePrivileges(pool, { runtimeRole, expectedDatabase }) {
  const role = identifier(runtimeRole);
  identifier(expectedDatabase);
  assert.ok(!["postgres", "template0", "template1"].includes(expectedDatabase));
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const context = (await connection.query(`SELECT current_database() AS db,current_user AS actor,
      (SELECT datdba FROM pg_database WHERE datname=current_database()) AS owner`)).rows[0];
    assert.equal(context.db, expectedDatabase);
    assert.notEqual(context.actor, runtimeRole);
    const identity = (await connection.query(`SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
      rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1`, [runtimeRole])).rows[0];
    assert.ok(identity?.rolcanlogin && !identity.rolsuper && !identity.rolcreatedb && !identity.rolcreaterole
      && !identity.rolreplication && !identity.rolbypassrls && identity.oid !== context.owner);
    assert.equal((await connection.query("SELECT count(*)::int AS n FROM pg_auth_members WHERE member=$1", [identity.oid])).rows[0].n, 0);
    assert.equal((await connection.query(`SELECT count(*)::int AS n FROM (
      SELECT oid FROM pg_class WHERE relowner=$1 UNION ALL SELECT oid FROM pg_proc WHERE proowner=$1
      UNION ALL SELECT oid FROM pg_namespace WHERE nspowner=$1) owned`, [identity.oid])).rows[0].n, 0);
    assert.equal((await connection.query(`SELECT has_database_privilege($1,current_database(),'CREATE,TEMPORARY')
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
      AND has_schema_privilege($1,oid,'CREATE')) AS unsafe`, [runtimeRole])).rows[0].unsafe, false);

    // Reset only this module's direct grants, including column grants left by a
    // previous version. PUBLIC/inherited privileges are verified below; an unsafe
    // effective grant rejects and rolls back, rather than masking the problem.
    for (const table of ["media_asset", "story_revision_asset"]) {
      await connection.query(`REVOKE ALL ON TABLE public.${table} FROM ${role}`);
      const columns = (await connection.query(`SELECT attname FROM pg_attribute
        WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`, [`public.${table}`])).rows;
      const list = columns.map(({ attname }) => `"${attname.replaceAll('"', '""')}"`).join(",");
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        await connection.query(`REVOKE ${privilege} (${list}) ON TABLE public.${table} FROM ${role}`);
      }
    }
    await connection.query(`GRANT SELECT ON public.media_asset TO ${role}`);
    await connection.query(`GRANT INSERT (id) ON public.media_asset TO ${role}`);
    await connection.query(`GRANT UPDATE (state,${metadata.join(",")},updated_at) ON public.media_asset TO ${role}`);

    const columns = (await connection.query(`SELECT attname,
      has_column_privilege($1,attrelid,attnum,'INSERT') AS ins,
      has_column_privilege($1,attrelid,attnum,'UPDATE') AS upd,
      has_column_privilege($1,attrelid,attnum,'REFERENCES') AS refs
      FROM pg_attribute WHERE attrelid='public.media_asset'::regclass AND attnum>0 AND NOT attisdropped`, [runtimeRole])).rows;
    for (const column of columns) {
      assert.equal(column.ins, column.attname === "id");
      assert.equal(column.upd, ["state", ...metadata, "updated_at"].includes(column.attname));
      assert.equal(column.refs, false);
    }
    assert.equal((await connection.query(`SELECT has_table_privilege($1,'public.media_asset',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS allowed`, [runtimeRole])).rows[0].allowed, false);
    for (const table of ["story_revision_asset", "AdminGrant", "AdminSecurityEvent", "story_revision", "star_slot"]) {
      // The draft service can separately receive INSERT on story_revision after
      // P2-08 integration; historical revisions must never become writable.
      const insert = table === "story_revision" ? "" : "INSERT,";
      assert.equal((await connection.query(`SELECT
        has_table_privilege($1,$2,$3) OR has_any_column_privilege($1,$2,$4) AS allowed`,
      [runtimeRole, `public."${table}"`, `${insert}UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER`, `${insert}UPDATE,REFERENCES`])).rows[0].allowed, false);
    }
    for (const column of ["state", "published_revision_id", "slot_id"]) {
      assert.equal((await connection.query(`SELECT has_column_privilege($1,'public.story',$2,'INSERT,UPDATE') AS allowed`,
        [runtimeRole, column])).rows[0].allowed, false);
    }
    for (const name of ["mq_project_revision_assets", "mq_guard_revision_asset", "mq_guard_media_asset"]) {
      assert.equal((await connection.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [runtimeRole, `public.${name}()`])).rows[0].allowed, false);
    }
    await connection.query("COMMIT");
    return { runtimeRole, target: expectedDatabase, mediaPrivileges: true };
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    throw new Error("MEDIA_PRIVILEGE_SETUP_REJECTED");
  } finally { connection.release(); }
}
