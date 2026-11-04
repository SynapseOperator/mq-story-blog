import assert from "node:assert/strict";

const identifier = value => {
  assert.match(value ?? "", /^[a-z][a-z0-9_]{0,62}$/);
  return `"${value}"`;
};

async function verifyRole(connection, role, database) {
  const identity = (await connection.query(`SELECT current_database() AS db, r.oid, r.rolcanlogin,
    (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR r.oid=(SELECT datdba FROM pg_database WHERE datname=current_database())
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
    OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE proowner=r.oid)
    OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
    OR has_database_privilege(r.oid,current_database(),'CREATE,TEMPORARY')
    OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
      AND has_schema_privilege(r.oid,oid,'CREATE'))) AS unsafe
    FROM pg_roles r WHERE rolname=$1`, [role])).rows[0];
  assert.ok(identity?.rolcanlogin && !identity.unsafe && identity.db === database);
  const columns = (await connection.query(`SELECT c.relname,a.attname,
    has_column_privilege($1,c.oid,a.attnum,'SELECT') AS sel,
    has_column_privilege($1,c.oid,a.attnum,'INSERT') AS ins,
    has_column_privilege($1,c.oid,a.attnum,'UPDATE') AS upd,
    has_column_privilege($1,c.oid,a.attnum,'REFERENCES') AS refs
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')`, [role])).rows;
  for (const column of columns) {
    assert.equal(column.sel, ["media_asset", "story_revision_asset"].includes(column.relname));
    assert.equal(column.ins, false);
    assert.equal(column.upd, column.relname === "media_asset" && ["state", "updated_at"].includes(column.attname));
    assert.equal(column.refs, false);
  }
  const dangerous = (await connection.query(`SELECT
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND CASE WHEN c.relkind IN ('r','p','v','m','f')
        THEN has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END)
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND CASE WHEN c.relkind='S'
        THEN has_sequence_privilege($1,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
    OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege($1,p.oid,'EXECUTE')) AS unsafe`, [role])).rows[0].unsafe;
  assert.equal(dangerous, false);
  return role;
}

/** Verifies the actual CLI identity, including inherited/PUBLIC privileges.
 * An application, owner or administrator-maintenance role fails this matrix. */
export async function verifyMediaMaintenanceConnection(pool, expectedDatabase) {
  try {
    const role = (await pool.query("SELECT current_user AS role")).rows[0].role;
    identifier(expectedDatabase); identifier(role);
    return await verifyRole(pool, role, expectedDatabase);
  } catch { throw new Error("MEDIA_MAINTENANCE_IDENTITY_REJECTED"); }
}

/** Explicit provisioning of a pre-created dedicated role. Never runs during
 * application startup and does not create/alter roles or reset other grants. */
export async function applyMediaMaintenancePrivileges(pool, { maintenanceRole, expectedDatabase }) {
  const role = identifier(maintenanceRole), database = identifier(expectedDatabase);
  assert.ok(!["postgres", "template0", "template1"].includes(expectedDatabase));
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const context = (await connection.query("SELECT current_database() AS db,current_user AS actor")).rows[0];
    assert.equal(context.db, expectedDatabase); assert.notEqual(context.actor, maintenanceRole);
    // PUBLIC CREATE/TEMPORARY must already be removed by the approved database
    // provisioning. Do not silently alter global/default privileges here.
    await connection.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
    await connection.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    for (const table of ["media_asset", "story_revision_asset"]) {
      await connection.query(`REVOKE ALL ON TABLE public.${table} FROM ${role}`);
      const columns = (await connection.query(`SELECT attname FROM pg_attribute
        WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`, [`public.${table}`])).rows;
      const list = columns.map(({ attname }) => `"${attname.replaceAll('"', '""')}"`).join(",");
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
        await connection.query(`REVOKE ${privilege} (${list}) ON public.${table} FROM ${role}`);
      }
    }
    await connection.query(`GRANT SELECT ON public.media_asset,public.story_revision_asset TO ${role}`);
    await connection.query(`GRANT UPDATE (state,updated_at) ON public.media_asset TO ${role}`);
    await verifyRole(connection, maintenanceRole, expectedDatabase);
    await connection.query("COMMIT");
    return { maintenanceRole, target: expectedDatabase, mediaMaintenancePrivileges: true };
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    throw new Error("MEDIA_MAINTENANCE_PRIVILEGE_SETUP_REJECTED");
  } finally { connection.release(); }
}
