import type { Prisma } from "../../generated/prisma/client.ts";

type PrivilegeRow = {
  tableName: string; columnName: string; canSelect: boolean; canInsert: boolean;
  canUpdate: boolean; canReference: boolean; unsafeTable: boolean; canGrant: boolean;
};
const expected = {
  story: { insert: ["id", "slug", "kind", "draft_revision_id"], update: ["draft_revision_id", "version", "updated_at"] },
  story_revision: { insert: ["id", "story_id", "title", "content"], update: [] },
  star_slot: { insert: [], update: [] },
} as const;

/** Static SQL shared by the request boundary and the explicit provisioning
 * verifier. There is no caller-supplied SQL, identifier or value interpolation.
 * PostgreSQL checks effective rights, including PUBLIC and inherited grants. */
export const DRAFT_PRIVILEGE_AUDIT_SQL = `
  SELECT c.relname AS "tableName", a.attname AS "columnName",
    pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'SELECT') AS "canSelect",
    pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'INSERT') AS "canInsert",
    pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') AS "canUpdate",
    pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES') AS "canReference",
    pg_catalog.has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS "unsafeTable",
    (pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION')
      OR pg_catalog.has_table_privilege(current_user,c.oid,'SELECT WITH GRANT OPTION')) AS "canGrant"
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
  WHERE n.nspname='public' AND c.relname IN ('story','story_revision','star_slot')
    AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`;

/** A missing capability is also an invalid runtime identity. Never leak the
 * rejected ACL, database name or connection details through an error message. */
export function assertDraftPrivilegeRows(rows: readonly PrivilegeRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const policy = expected[row.tableName as keyof typeof expected];
    if (!policy || !row.canSelect || row.unsafeTable || row.canReference || row.canGrant
      || row.canInsert !== (policy.insert as readonly string[]).includes(row.columnName)
      || row.canUpdate !== (policy.update as readonly string[]).includes(row.columnName)) {
      throw new Error("ADMIN_DRAFT_DATABASE_PRIVILEGES_REJECTED");
    }
    seen.add(`${row.tableName}.${row.columnName}`);
  }
  for (const [table, policy] of Object.entries(expected)) {
    if (!rows.some(row => row.tableName === table)
      || [...policy.insert, ...policy.update].some(column => !seen.has(`${table}.${column}`))) {
      throw new Error("ADMIN_DRAFT_DATABASE_PRIVILEGES_REJECTED");
    }
  }
}

/** Call inside withAdmin's transaction before every private draft operation.
 * This supplements, rather than replaces, its authorization and role checks. */
export async function assertDraftDatabasePrivileges(tx: Prisma.TransactionClient): Promise<void> {
  // $queryRawUnsafe is only used for this immutable, argument-free SQL constant
  // so the operator's verifier and server evaluate exactly the same policy.
  assertDraftPrivilegeRows(await tx.$queryRawUnsafe<PrivilegeRow[]>(DRAFT_PRIVILEGE_AUDIT_SQL));
}
