import type { Prisma } from "../../generated/prisma/client.ts";
import { LikeOperationError } from "./policy.ts";

// Shared with the explicit test provisioner. Runtime may keep existing draft
// columns, but must never gain Session or publication-field UPDATE for locks.
export const LIKE_PRIVILEGE_AUDIT_SQL = `SELECT (
  r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
  OR pg_catalog.pg_has_role(current_user,(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.story_like'::regclass),'MEMBER')
  OR pg_catalog.pg_has_role(current_user,(SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.mq_lock_story_like_access(text,text,uuid)'::regprocedure),'MEMBER')
  OR pg_catalog.has_any_column_privilege(current_user,'public."Session"','UPDATE')
  OR pg_catalog.has_column_privilege(current_user,'public.story','state','INSERT,UPDATE')
  OR pg_catalog.has_column_privilege(current_user,'public.story','published_revision_id','INSERT,UPDATE')
  OR pg_catalog.has_column_privilege(current_user,'public.story','slot_id','INSERT,UPDATE')
  OR pg_catalog.has_table_privilege(current_user,'public.story_like','UPDATE,TRUNCATE,REFERENCES,TRIGGER')
  OR pg_catalog.has_any_column_privilege(current_user,'public.story_like','UPDATE,REFERENCES')
  OR pg_catalog.has_database_privilege(current_user,current_database(),'CREATE,TEMPORARY')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE'))
) AS unsafe FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;

export function assertLikePrivilegeRows(rows: { unsafe: boolean }[]) {
  if (rows.length !== 1 || rows[0].unsafe !== false) throw new LikeOperationError("LIKES_UNAVAILABLE");
}
export async function assertLikeDatabasePrivileges(tx: Prisma.TransactionClient) {
  assertLikePrivilegeRows(await tx.$queryRawUnsafe<{ unsafe: boolean }[]>(LIKE_PRIVILEGE_AUDIT_SQL));
}
