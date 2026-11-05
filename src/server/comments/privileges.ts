import type { Prisma } from "../../generated/prisma/client.ts";
import { CommentOperationError } from "./policy.ts";

export const COMMENT_PRIVILEGE_AUDIT_SQL = `SELECT (
  r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid)
  OR pg_catalog.pg_has_role(current_user,(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.story_comment'::regclass),'MEMBER')
  OR pg_catalog.pg_has_role(current_user,(SELECT proowner FROM pg_catalog.pg_proc WHERE oid='public.mq_apply_comment_moderation(text,bytea)'::regprocedure),'MEMBER')
  OR pg_catalog.has_any_column_privilege(current_user,'public."Session"','UPDATE')
  OR pg_catalog.has_table_privilege(current_user,'public.story_comment','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR pg_catalog.has_any_column_privilege(current_user,'public.story_comment','UPDATE,REFERENCES')
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['state','version','created_at','moderated_at','moderated_by','approved_at']) AS col
    WHERE pg_catalog.has_column_privilege(current_user,'public.story_comment',col,'INSERT'))
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='mq_comment_private' AND c.relname='moderation_key' AND (
      pg_catalog.has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
  OR pg_catalog.has_schema_privilege(current_user,'mq_comment_private','USAGE,CREATE')
  OR pg_catalog.has_database_privilege(current_user,current_database(),'CREATE,TEMPORARY')
  OR EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE'))
) AS unsafe FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`;

export function assertCommentPrivilegeRows(rows: { unsafe: boolean }[]) {
  if (rows.length !== 1 || rows[0].unsafe !== false) throw new CommentOperationError("COMMENT_UNAVAILABLE");
}
export async function assertCommentDatabasePrivileges(tx: Prisma.TransactionClient) {
  assertCommentPrivilegeRows(await tx.$queryRawUnsafe<{ unsafe: boolean }[]>(COMMENT_PRIVILEGE_AUDIT_SQL));
}
