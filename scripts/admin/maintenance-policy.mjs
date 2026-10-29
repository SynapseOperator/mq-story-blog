import { URL } from "node:url";

const operations = new Set(["init", "revoke", "restore", "reset-password"]);
const name = /^[a-z][a-z0-9_]{0,62}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMaintenanceArguments(argv) {
  const values = {};
  const allowed = new Set(["--database", "--operation", "--username", "--user-id", "--expected-version"]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || Object.hasOwn(values, key) || !value || value.startsWith("--")) throw new Error("INVALID_ARGUMENTS");
    values[key] = value;
  }
  const database = values["--database"];
  const operation = values["--operation"];
  if (!name.test(database ?? "") || ["postgres", "template0", "template1"].includes(database) || !operations.has(operation)) throw new Error("INVALID_ARGUMENTS");
  if (operation === "init") {
    if (Object.keys(values).length !== 3 || !/^[a-zA-Z0-9_]{3,32}$/.test(values["--username"] ?? "")) throw new Error("INVALID_ARGUMENTS");
    return { database, operation, username: values["--username"].toLowerCase() };
  }
  const version = values["--expected-version"];
  if (Object.keys(values).length !== 4 || !uuid.test(values["--user-id"] ?? "") || !/^(0|[1-9][0-9]*)$/.test(version ?? "")
    || !Number.isSafeInteger(Number(version)) || Number(version) >= 2_147_483_647) throw new Error("INVALID_ARGUMENTS");
  return { database, operation, userId: values["--user-id"], expectedVersion: Number(version) };
}

export function validateMaintenanceTarget(value, database) {
  let target;
  try { target = new URL(value); } catch { throw new Error("INVALID_MAINTENANCE_TARGET"); }
  if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
    || target.pathname !== `/${database}` || !target.port || target.search || target.hash || !target.password
    || !name.test(target.username) || ["postgres", "mq_dev", "mq_test"].includes(target.username)) throw new Error("INVALID_MAINTENANCE_TARGET");
  return target;
}

export function maintenanceConfirmation(input) {
  return `${input.operation.toUpperCase()} ${input.database} ${input.operation === "init" ? input.username : input.userId}`;
}

export function assertMaintenanceIdentity(row, database) {
  if (!row || row.database !== database || typeof row.role !== "string" || !name.test(row.role)
    || ["postgres", "mq_dev", "mq_test"].includes(row.role)
    || ["superuser", "createdb", "createrole", "replication", "bypassrls", "hasMembership", "ownsObjects", "canCreateSchema", "canCreateDatabaseObjects",
      "canWriteAudit", "canDeleteGrant", "canTruncateGrant", "canMigrate"].some(key => row[key] !== false)
    || row.canMaintainGrant !== true || row.canResetPassword !== true) {
    throw new Error("MAINTENANCE_IDENTITY_REJECTED");
  }
}

/** Shared by the actual CLI and real PostgreSQL integration tests. */
export async function verifyMaintenanceConnection(pool, database) {
  const { rows } = await pool.query(`
    SELECT current_database() AS "database", current_user AS "role",
      r.rolsuper AS "superuser", r.rolcreatedb AS "createdb", r.rolcreaterole AS "createrole",
      r.rolreplication AS "replication", r.rolbypassrls AS "bypassrls",
      EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS "hasMembership",
      (EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND pg_has_role(current_user,c.relowner,'USAGE'))
       OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND pg_has_role(current_user,p.proowner,'USAGE'))) AS "ownsObjects",
      has_schema_privilege(current_user,'public','CREATE') AS "canCreateSchema",
      has_database_privilege(current_user,current_database(),'CREATE') AS "canCreateDatabaseObjects",
      (has_table_privilege(current_user,'public."AdminSecurityEvent"','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR has_any_column_privilege(current_user,'public."AdminSecurityEvent"','INSERT,UPDATE,REFERENCES')) AS "canWriteAudit",
      has_table_privilege(current_user,'public."AdminGrant"','DELETE') AS "canDeleteGrant",
      has_table_privilege(current_user,'public."AdminGrant"','TRUNCATE') AS "canTruncateGrant",
      (has_table_privilege(current_user,'public."_prisma_migrations"','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR has_any_column_privilege(current_user,'public."_prisma_migrations"','INSERT,UPDATE,REFERENCES')) AS "canMigrate",
      (has_table_privilege(current_user,'public."AdminGrant"','SELECT')
        AND has_table_privilege(current_user,'public."AdminGrant"','INSERT')
        AND has_column_privilege(current_user,'public."AdminGrant"','version','UPDATE')
        AND has_column_privilege(current_user,'public."AdminGrant"','revokedAt','UPDATE')) AS "canMaintainGrant",
      (has_column_privilege(current_user,'public."Account"','password','UPDATE')
        AND has_column_privilege(current_user,'public."Account"','updatedAt','UPDATE')) AS "canResetPassword"
    FROM pg_roles r WHERE r.rolname=current_user`);
  assertMaintenanceIdentity(rows[0], database);
  return rows[0].role;
}
