import { createHmac } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.ts";

export const AUTH_LIMITS = { username: 8, client: 20, global: 120, windowSeconds: 60 } as const;

/** Shared atomic fixed windows, keyed with HMAC; no raw IP, cookie or username is persisted. */
export async function consumeAuthLimit(db: PrismaClient, secret: string, path: string, client: string, username?: string) {
  const sensitive = path === "/sign-up/email" || path === "/sign-in/username";
  const buckets = [
    { identity: `global:${path}`, max: sensitive ? AUTH_LIMITS.global : 3000 },
    { identity: `client:${path}:${client}`, max: sensitive ? AUTH_LIMITS.client : 240 },
    ...(username ? [{ identity: `username:${path}:${username}`, max: AUTH_LIMITS.username }] : []),
  ].map(({ identity, max }) => ({ key: createHmac("sha256", secret).update(identity).digest("hex"), max }));
  // Global bucket first bounds attacker-created cardinality. All callers use the
  // same order (global -> client -> username), avoiding cross-instance deadlocks.
  return db.$transaction(async tx => {
    // Expired entries contain only hashed subjects. Bounded by global admitted
    // requests; cleanup never scans or removes authentication/business records.
    await tx.$executeRaw`DELETE FROM "AuthRateLimit" WHERE "expiresAt" < now() - interval '1 hour'`;
    for (const bucket of buckets) {
      const rows = await tx.$queryRaw<{ count: number; retry: number }[]>`
        INSERT INTO "AuthRateLimit" ("key", "count", "expiresAt")
        VALUES (${bucket.key}, 1, now() + interval '60 seconds')
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE WHEN "AuthRateLimit"."expiresAt" <= now() THEN 1 ELSE LEAST("AuthRateLimit"."count" + 1, ${bucket.max + 1}) END,
          "expiresAt" = CASE WHEN "AuthRateLimit"."expiresAt" <= now() THEN now() + interval '60 seconds' ELSE "AuthRateLimit"."expiresAt" END
        RETURNING "count", GREATEST(1, ceil(extract(epoch FROM ("expiresAt" - now()))))::int AS retry`;
      if (rows[0].count > bucket.max) return { allowed: false, retryAfter: rows[0].retry };
    }
    return { allowed: true, retryAfter: 0 };
  }, { maxWait: 5000, timeout: 10000 });
}
