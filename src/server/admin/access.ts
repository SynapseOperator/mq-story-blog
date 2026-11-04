import type { Prisma } from "../../generated/prisma/client.ts";
import { authConfiguration } from "../auth/policy.ts";
import { readVerifiedSession } from "../auth/service.ts";
import { createAuthDatabaseClient } from "../auth/database.ts";
import { consumeAuthLimit } from "../auth/rate-limit.ts";
import { AdminAccessError, inspectAdminRequest } from "./policy.ts";

// Server-only identity. Never serialize the session ID into an API response.
export type AdminPrincipal = Readonly<{ userId: string; sessionId: string }>;
let database: ReturnType<typeof createAuthDatabaseClient> | undefined;

/** All future management handlers/services must execute their database work
 * INSIDE this callback using tx. Never return the transaction or an authorization
 * boolean to reuse later. Grant/session locks serialize maintenance with the
 * operation; external IO must not be performed while holding these short locks.
 */
export async function withAdmin<T>(request: Request,
  operation: (tx: Prisma.TransactionClient, principal: AdminPrincipal) => Promise<T>): Promise<T> {
  try {
    const config = authConfiguration();
    const client = inspectAdminRequest(request, config);
    const db = database ??= createAuthDatabaseClient(config.databaseURL);
    const limit = await consumeAuthLimit(db, config.secret, "/admin-access", client);
    if (!limit.allowed) throw new AdminAccessError("ADMIN_RATE_LIMITED", 429);
    // Better Auth validates the signature and database-backed session. No user ID
    // from request JSON, cookies other than BA's signed cookie, or headers is used.
    const verified = await readVerifiedSession(request.headers);
    if (!verified) throw new AdminAccessError("ADMIN_UNAUTHENTICATED", 401);
    return await db.$transaction(async tx => {
      // Refuse a migration/maintenance/owner connection even in local preview.
      // This is a fail-closed safeguard, not proof of production provisioning.
      const roles = await tx.$queryRaw<{ unsafe: boolean }[]>`
        SELECT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
          OR pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
          OR pg_catalog.has_table_privilege(current_user, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
          OR pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE')
          OR pg_catalog.has_any_column_privilege(current_user, 'public."Account"', 'UPDATE')
          OR pg_catalog.has_table_privilege(current_user, 'public."Account"', 'DELETE,TRUNCATE,TRIGGER')
          OR pg_catalog.has_any_column_privilege(current_user, 'public."User"', 'UPDATE')
          OR pg_catalog.has_table_privilege(current_user, 'public."User"', 'DELETE,TRUNCATE,TRIGGER')
          OR pg_catalog.has_any_column_privilege(current_user, 'public."Session"', 'UPDATE')
          OR pg_catalog.has_table_privilege(current_user, 'public."AdminSecurityEvent"', 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
          OR pg_catalog.has_any_column_privilege(current_user, 'public."AdminSecurityEvent"', 'INSERT,UPDATE')
          OR pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE,TEMPORARY')
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace ns WHERE ns.nspname !~ '^pg_'
            AND ns.nspname <> 'information_schema' AND pg_catalog.has_schema_privilege(current_user, ns.oid, 'CREATE'))
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace ns ON ns.oid = p.pronamespace
            WHERE ns.nspname = 'public' AND pg_catalog.pg_has_role(current_user, p.proowner, 'MEMBER'))
          OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members membership WHERE membership.member = r.oid)) AS unsafe
        FROM pg_catalog.pg_roles r, pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE r.rolname = current_user AND n.nspname = 'public' AND c.relname = 'AdminGrant'`;
      if (roles.length !== 1 || roles[0].unsafe) throw new AdminAccessError("ADMIN_UNAVAILABLE", 503);
      // SECURITY DEFINER is narrowly limited to validation and row locks, because
      // PostgreSQL row-locking SELECT requires UPDATE privilege. Runtime roles
      // receive EXECUTE, never write access to the authorization table.
      const rows = await tx.$queryRaw<{ allowed: boolean }[]>`
        SELECT public.mq_lock_admin_access(${verified.sessionId}, ${verified.user.id}) AS allowed`;
      if (rows.length !== 1 || rows[0].allowed !== true) throw new AdminAccessError("ADMIN_FORBIDDEN", 403);
      return await operation(tx, Object.freeze({ userId: verified.user.id, sessionId: verified.sessionId }));
    }, { maxWait: 5000, timeout: 5000 });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      console.error(error.status === 503 ? "MQ_ADMIN_UNAVAILABLE" : "MQ_ADMIN_ACCESS_REJECTED");
      throw error;
    }
    // Do not serialize driver/framework errors, cookie headers, or their causes.
    console.error("MQ_ADMIN_UNAVAILABLE");
    throw new AdminAccessError("ADMIN_UNAVAILABLE", 503);
  }
}
