import { Prisma } from "../../generated/prisma/client.ts";
import { LikeOperationError } from "./policy.ts";
import { assertLikeDatabasePrivileges } from "./privileges.ts";

export type LikePrincipal = Readonly<{ userId: string; sessionId: string }>;
export type StoryLikeState = { count: number; liked: boolean };

/** The caller owns the connection. set MUST run inside one transaction: never
 * detach the authorization/row locks from the mutation and returned count. */
export function createStoryLikeOperations(tx: Prisma.TransactionClient) {
  return {
    async read(id: string, principal: LikePrincipal | null): Promise<StoryLikeState> {
      // Anonymous reads need no privileges on authentication tables. An optional
      // verified principal is rechecked in the same snapshot as count/state.
      const liked = principal ? Prisma.sql`EXISTS (
        SELECT 1 FROM public.story_like mine JOIN public."Session" session ON session."userId"=mine.user_id
        WHERE mine.story_id=s.id AND mine.user_id=${principal.userId} AND session.id=${principal.sessionId}
          AND session."expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC'))` : Prisma.sql`false`;
      const rows = await tx.$queryRaw<StoryLikeState[]>`
        SELECT (SELECT count(*)::int FROM public.story_like likes WHERE likes.story_id=s.id) AS count,
          ${liked} AS liked
        FROM public.story s JOIN public.story_revision r ON r.story_id=s.id AND r.id=s.published_revision_id
        WHERE s.id=${id}::uuid AND s.state='PUBLISHED'::public."StoryState"`;
      if (!rows[0]) throw new LikeOperationError("LIKES_NOT_FOUND");
      return { count: rows[0].count, liked: rows[0].liked };
    },
    async set(id: string, principal: LikePrincipal, liked: boolean): Promise<StoryLikeState> {
      await assertLikeDatabasePrivileges(tx);
      const rows = await tx.$queryRaw<{ access: string }[]>`
        SELECT public.mq_lock_story_like_access(${principal.sessionId},${principal.userId},${id}::uuid) AS access`;
      if (rows[0]?.access === "unauthenticated") throw new LikeOperationError("LIKES_UNAUTHENTICATED");
      if (rows[0]?.access === "not_found") throw new LikeOperationError("LIKES_NOT_FOUND");
      if (rows[0]?.access !== "allowed") throw new LikeOperationError("LIKES_UNAVAILABLE");
      if (liked) {
        await tx.$executeRaw`INSERT INTO public.story_like(user_id,story_id) VALUES(${principal.userId},${id}::uuid)
          ON CONFLICT (user_id,story_id) DO NOTHING`;
      } else {
        await tx.$executeRaw`DELETE FROM public.story_like WHERE user_id=${principal.userId} AND story_id=${id}::uuid`;
      }
      const counts = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM public.story_like WHERE story_id=${id}::uuid`;
      return { count: counts[0].count, liked };
    },
  };
}
