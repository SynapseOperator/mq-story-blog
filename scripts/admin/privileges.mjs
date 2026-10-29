import assert from "node:assert/strict";

const objects = ["User", "Account", "Session", "Verification", "RateLimit", "AuthRateLimit",
  "AdminGrant", "AdminSecurityEvent", "story", "story_revision", "star_slot", "database_probe", "_prisma_migrations"];
const identifier = (value) => {
  assert.match(value ?? "", /^[a-z][a-z0-9_]{2,62}$/, "Database role/target identifier is invalid");
  return `"${value}"`;
};

/** Explicit provisioning, never a server startup hook. The caller must connect
 * with a separately controlled migration/provisioning identity. No role is
 * created/altered, and grants/revokes are scoped to the named current database.
 * Production roles and network/secret controls still require operator review.
 */
export async function applyAdminDatabasePrivileges(pool, { runtimeRole, maintenanceRole, expectedDatabase }) {
  const runtime = identifier(runtimeRole);
  const maintenance = identifier(maintenanceRole);
  const database = identifier(expectedDatabase);
  assert.notEqual(runtimeRole, maintenanceRole, "Runtime and maintenance identities must differ");
  assert.ok(!["postgres", "template0", "template1"].includes(expectedDatabase), "System databases are forbidden");
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const context = (await connection.query(`SELECT current_database() AS db, current_user AS actor,
      (SELECT datdba FROM pg_database WHERE datname=current_database()) AS owner`)).rows[0];
    assert.equal(context.db, expectedDatabase, "Provisioning target mismatch");
    for (const name of [runtimeRole, maintenanceRole]) {
      assert.notEqual(name, context.actor, "Provisioning must not use an application identity");
      const role = (await connection.query(`SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
        rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname=$1`, [name])).rows[0];
      assert.ok(role?.rolcanlogin, "A pre-created restricted login role is required");
      assert.ok(!role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication
        && !role.rolbypassrls && role.oid !== context.owner, "Privileged database roles are forbidden");
      assert.equal((await connection.query("SELECT count(*)::int AS n FROM pg_auth_members WHERE member=$1", [role.oid])).rows[0].n,
        0, "Application identities may not inherit or SET ROLE to other identities");
      assert.equal((await connection.query(`SELECT count(*)::int AS n FROM (
        SELECT oid FROM pg_class WHERE relowner=$1 UNION ALL SELECT oid FROM pg_proc WHERE proowner=$1
        UNION ALL SELECT oid FROM pg_namespace WHERE nspowner=$1
      ) owned`, [role.oid])).rows[0].n, 0, "Application identities must not own database objects");
      assert.equal((await connection.query(`SELECT count(*)::int AS n FROM pg_namespace
        WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
          AND has_schema_privilege($1, oid, 'CREATE')`, [name])).rows[0].n,
      0, "Application identities must not have schema CREATE privileges");
    }
    // TEMP/CREATE are database-scoped. PUBLIC defaults cannot give either
    // application role an alternate DDL path in this explicitly selected DB.
    await connection.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    for (const role of [runtime, maintenance]) {
      await connection.query(`REVOKE ALL ON DATABASE ${database} FROM ${role}`);
      await connection.query(`GRANT CONNECT ON DATABASE ${database} TO ${role}`);
      await connection.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
      await connection.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      for (const table of objects) {
        await connection.query(`REVOKE ALL ON TABLE public."${table}" FROM ${role}`);
        // Table-level REVOKE does not remove an earlier column-level grant.
        const columns = (await connection.query(`SELECT attname FROM pg_attribute
          WHERE attrelid=$1::regclass AND attnum > 0 AND NOT attisdropped`, [`public."${table}"`])).rows;
        const list = columns.map(({ attname }) => `"${attname.replaceAll('"', '""')}"`).join(", ");
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
          await connection.query(`REVOKE ${privilege} (${list}) ON TABLE public."${table}" FROM ${role}`);
        }
      }
      await connection.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`);
    }
    await connection.query(`GRANT SELECT, INSERT ON public."User", public."Account" TO ${runtime}, ${maintenance}`);
    await connection.query(`GRANT SELECT, INSERT, DELETE ON public."Session" TO ${runtime}`);
    await connection.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public."RateLimit", public."AuthRateLimit" TO ${runtime}`);
    await connection.query(`GRANT SELECT ON public."AdminGrant", public.story, public.story_revision, public.star_slot TO ${runtime}`);
    await connection.query(`GRANT EXECUTE ON FUNCTION public.mq_lock_admin_access(text,text) TO ${runtime}`);
    await connection.query(`GRANT EXECUTE ON FUNCTION public.mq_lock_admin_credentials(text) TO ${runtime}`);
    await connection.query(`GRANT SELECT, DELETE ON public."Session" TO ${maintenance}`);
    await connection.query(`GRANT UPDATE ("password", "updatedAt") ON public."Account" TO ${maintenance}`);
    await connection.query(`GRANT SELECT, INSERT ON public."AdminGrant" TO ${maintenance}`);
    await connection.query(`GRANT UPDATE ("version", "revokedAt") ON public."AdminGrant" TO ${maintenance}`);
    await connection.query(`GRANT SELECT ON public."AdminSecurityEvent" TO ${maintenance}`);
    // REVOKE from one role cannot remove PUBLIC privileges. Refuse a database
    // whose effective grants still admit escalation; never silently assert that
    // the runtime is isolated merely because our GRANT statements succeeded.
    async function noPrivileges(name, table, tablePrivileges, columnPrivileges) {
      const effective = (await connection.query(`SELECT
        has_table_privilege($1,$2,$3) AS table_access,
        has_any_column_privilege($1,$2,$4) AS column_access`,
      [name, `public."${table}"`, tablePrivileges, columnPrivileges])).rows[0];
      assert.ok(!effective.table_access && !effective.column_access, "Unsafe effective database privileges remain");
    }
    for (const name of [runtimeRole, maintenanceRole]) {
      await noPrivileges(name, "AdminSecurityEvent", "INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER", "INSERT,UPDATE,REFERENCES");
      await noPrivileges(name, "_prisma_migrations", "INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER", "INSERT,UPDATE,REFERENCES");
      const ddl = (await connection.query(`SELECT
        has_database_privilege($1,current_database(),'CREATE,TEMPORARY') OR
        EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
          AND has_schema_privilege($1,oid,'CREATE')) AS allowed`, [name])).rows[0].allowed;
      assert.equal(ddl, false, "Unsafe effective DDL privileges remain");
    }
    await noPrivileges(runtimeRole, "AdminGrant", "INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER", "INSERT,UPDATE,REFERENCES");
    await noPrivileges(runtimeRole, "Account", "UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER", "UPDATE,REFERENCES");
    await noPrivileges(runtimeRole, "User", "UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER", "UPDATE,REFERENCES");
    await noPrivileges(runtimeRole, "Session", "UPDATE,TRUNCATE,REFERENCES,TRIGGER", "UPDATE,REFERENCES");
    await connection.query("COMMIT");
    return { runtimeRole, maintenanceRole, target: expectedDatabase, separateIdentities: true };
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    // Do not serialize driver errors, identifiers or connection credentials.
    throw new Error("ADMIN_PRIVILEGE_SETUP_REJECTED");
  } finally { connection.release(); }
}
