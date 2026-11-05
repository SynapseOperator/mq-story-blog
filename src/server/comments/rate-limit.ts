import { createHmac } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.ts";

export const COMMENT_LIMITS = { global: 120, client: 5, account: 8, windowSeconds: 60 } as const;

/** Separate comment buckets, using the existing atomic shared table. Replays
 * consume quota too; raw client addresses and account IDs never enter storage. */
export async function consumeCommentLimit(db: PrismaClient, secret: string, client: string, userId?: string) {
  const buckets = [
    { identity: "comments:global", max: COMMENT_LIMITS.global },
    { identity: `comments:client:${client}`, max: COMMENT_LIMITS.client },
    ...(userId ? [{ identity: `comments:account:${userId}`, max: COMMENT_LIMITS.account }] : []),
  ].map(({ identity, max }) => ({ key: createHmac("sha256", secret).update(identity).digest("hex"), max }));
  return db.$transaction(async tx => {
    await tx.$executeRaw`DELETE FROM "AuthRateLimit" WHERE "expiresAt" < now() - interval '1 hour'`;
    // Stable global -> client -> account order also bounds attacker-created keys.
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
