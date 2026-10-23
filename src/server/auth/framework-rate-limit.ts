import { createHmac, randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.ts";
import { AuthLimiterError } from "./failure.ts";

/** Better Auth 1.7.12's public customStorage.consume contract. The framework
 * guard remains enabled; only its read/create/retry DB implementation changes.
 * This guard retains BA's accepted-request/inactivity-window semantics. The
 * project AuthRateLimit is the independent primary fixed-window admission gate.
 */
export function createFrameworkRateLimitStorage(db: PrismaClient, secret: string) {
  return {
    async consume(key: string, rule: { window: number; max: number }): Promise<{ allowed: boolean; retryAfter: number | null }> {
      if (!Number.isSafeInteger(rule.window) || rule.window < 1 || rule.window > 86400
        || !Number.isSafeInteger(rule.max) || rule.max < 1 || rule.max > 1_000_000) throw new AuthLimiterError();
      const identity = createHmac("sha256", secret).update(`framework:${key}`).digest("hex");
      const windowMs = BigInt(rule.window * 1000);
      try {
        // The unique-key arbiter, decision and increment run in one SQL statement.
        // No competing INSERT can surface a recoverable unique violation.
        const accepted = await db.$queryRaw<{ count: number }[]>`
          INSERT INTO "RateLimit" ("id", "key", "count", "lastRequest")
          VALUES (${randomUUID()}, ${identity}, 1, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
          ON CONFLICT ("key") DO UPDATE SET
            "count" = CASE WHEN "RateLimit"."lastRequest" <= EXCLUDED."lastRequest" - ${windowMs}
              THEN 1 ELSE "RateLimit"."count" + 1 END,
            "lastRequest" = GREATEST("RateLimit"."lastRequest", EXCLUDED."lastRequest")
          WHERE "RateLimit"."lastRequest" <= EXCLUDED."lastRequest" - ${windowMs} OR "RateLimit"."count" < ${rule.max}
          RETURNING "count"`;
        if (accepted.length) return { allowed: true, retryAfter: null };
        const rows = await db.$queryRaw<{ retry: number }[]>`
          SELECT GREATEST(1, ceil(("lastRequest" + ${windowMs} - extract(epoch FROM clock_timestamp()) * 1000) / 1000))::int AS retry
          FROM "RateLimit" WHERE "key" = ${identity}`;
        return { allowed: false, retryAfter: rows[0]?.retry ?? rule.window };
      } catch { throw new AuthLimiterError(); }
    },
  };
}
