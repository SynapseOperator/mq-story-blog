import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { hashPassword } from "../auth/password.ts";

let locks: PrismaClient | undefined;

/** A username only locates a credential operation to serialize; it NEVER grants
 * authority. Initialization creates a new dedicated identity, so an existing
 * public account cannot become an administrator between the lookup and login.
 * Password resets lock the same stable grant first. Keep the lock until the full
 * Better Auth response exists AND this transaction has committed; a timeout or
 * connection failure must not release a response carrying a new session cookie.
 */
export async function withAdminCredentialLock(db: PrismaClient, connectionString: string,
  input: { username: string; password: string }, authenticate: () => Promise<Response>): Promise<Response> {
  const users = await db.$queryRaw<{ userId: string | null }[]>`
    SELECT g."userId" FROM public."User" u LEFT JOIN public."AdminGrant" g ON g."userId" = u.id AND g.id = 1
    WHERE u.username = ${input.username}`;
  // Do not let a not-yet-committed dedicated initialization appear later inside
  // Better Auth after we classified the name as not needing a credential lock.
  if (!users.length) {
    // Preserve Username plugin's unknown-user dummy hash and shared bounded
    // password queue; early race-safe denial must not become a fast name oracle.
    await hashPassword(input.password);
    return Response.json({ code: "INVALID_CREDENTIALS" }, { status: 401 });
  }
  if (!users[0].userId) return authenticate();
  // Separate bounded pool: holding a grant lock must never exhaust the adapter
  // connections needed by Better Auth itself to validate/create a session.
  const locker = locks ??= new PrismaClient({ adapter: new PrismaPg({
    connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
  }) });
  return locker.$transaction(async tx => {
    const held = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT public.mq_lock_admin_credentials(${users[0].userId}) AS locked`;
    if (held.length !== 1 || held[0].locked !== true) throw new Error("ADMIN_CREDENTIAL_LOCK_UNAVAILABLE");
    return await authenticate();
  }, { maxWait: 5000, timeout: 5000 });
}
