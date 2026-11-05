import { createHmac, randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { CommentOperationError } from "./policy.ts";
import { assertCommentDatabasePrivileges } from "./privileges.ts";

export type CommentPrincipal = Readonly<{ userId: string; sessionId: string }>;
export type CommentState = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
export type CommentCursor = { createdAt: string; id: string };
export type CommentPage = { limit: number; cursor?: CommentCursor };
export type PublicComment = { id: string; body: string; author: string; createdAt: string };
export type AdminComment = PublicComment & { storyId: string; state: CommentState; version: number;
  storyDraftTitle: string; storyState: "DRAFT" | "PUBLISHED" | "WITHDRAWN";
  moderatedAt: string | null; approvedAt: string | null };
export type ModerationAction = "approve" | "reject" | "withdraw";

async function operation<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof CommentOperationError) throw error;
    const value = error as { meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } };
    const code = value?.meta?.code ?? value?.meta?.driverAdapterError?.cause?.originalCode;
    if (code === "P7200") throw new CommentOperationError("COMMENT_VALIDATION");
    if (code === "P7201") throw new CommentOperationError("COMMENT_FORBIDDEN");
    if (code === "P7203" || code === "23505") throw new CommentOperationError("COMMENT_CONFLICT");
    if (code === "P7204") throw new CommentOperationError("COMMENT_NOT_FOUND");
    if (code === "P7205") throw new CommentOperationError("COMMENT_INVALID_STATE");
    throw new CommentOperationError("COMMENT_UNAVAILABLE");
  }
}

/** Callers own transactions. submit and moderate never detach locks from writes;
 * every admin read/write is invoked in withAdmin's callback using that same tx. */
export function createStoryCommentOperations(tx: Prisma.TransactionClient) {
  return {
    listPublic(storyId: string, page: CommentPage) {
      return operation(async () => {
        const cursor = page.cursor ? Prisma.sql`AND (c.created_at,c.id)<(${page.cursor.createdAt}::timestamptz,${page.cursor.id}::uuid)` : Prisma.empty;
        // Publication, count and page use one SQL snapshot, including empty pages.
        const rows = await tx.$queryRaw<{ count: number; items: PublicComment[] }[]>`
          SELECT (SELECT count(*)::int FROM public.story_comment c WHERE c.story_id=s.id AND c.state='APPROVED') AS count,
            COALESCE((SELECT jsonb_agg(selected ORDER BY selected."createdAt" DESC,selected.id DESC) FROM (
              SELECT c.id,c.body,COALESCE(u.username,'匿名访客') AS author,c.created_at AS "createdAt"
              FROM public.story_comment c LEFT JOIN public."User" u ON u.id=c.user_id
              WHERE c.story_id=s.id AND c.state='APPROVED' ${cursor}
              ORDER BY c.created_at DESC,c.id DESC LIMIT ${page.limit + 1}
            ) selected),'[]'::jsonb) AS items
          FROM public.story s JOIN public.story_revision r ON r.story_id=s.id AND r.id=s.published_revision_id
          WHERE s.id=${storyId}::uuid AND s.state='PUBLISHED'`;
        if (!rows[0]) throw new CommentOperationError("COMMENT_NOT_FOUND");
        const items = rows[0].items.slice(0, page.limit).map(item => ({ ...item, createdAt: new Date(item.createdAt).toISOString() }));
        const last = items.at(-1);
        return { items, count: rows[0].count, nextCursor: rows[0].items.length > page.limit && last ? { createdAt: last.createdAt, id: last.id } : null };
      });
    },

    submit(storyId: string, input: { principal: CommentPrincipal | null; body: string; idempotencyKeyHash: string }) {
      return operation(async () => {
        await assertCommentDatabasePrivileges(tx);
        const [context] = await tx.$queryRaw<{ access: string }[]>`
          SELECT public.mq_lock_comment_context(${input.principal?.sessionId ?? null},${input.principal?.userId ?? null},${storyId}::uuid) AS access`;
        if (context?.access === "unauthenticated") throw new CommentOperationError("COMMENT_UNAUTHENTICATED");
        if (context?.access !== "PUBLISHED") throw new CommentOperationError("COMMENT_NOT_FOUND");
        const userId = input.principal?.userId ?? null;
        await tx.$executeRaw`INSERT INTO public.story_comment(id,story_id,user_id,body,submission_key_hash)
          VALUES(${randomUUID()}::uuid,${storyId}::uuid,${userId},${input.body},${input.idempotencyKeyHash})
          ON CONFLICT (submission_key_hash) DO NOTHING`;
        // A separate READ COMMITTED statement sees the winning committed insert
        // after ON CONFLICT waits. Never return its later moderation state.
        const [receipt] = await tx.$queryRaw<{ id: string; storyId: string; userId: string | null; body: string }[]>`
          SELECT id,story_id AS "storyId",user_id AS "userId",body FROM public.story_comment
          WHERE submission_key_hash=${input.idempotencyKeyHash}`;
        if (!receipt || receipt.storyId !== storyId.toLowerCase() || receipt.userId !== userId || receipt.body !== input.body) {
          throw new CommentOperationError("COMMENT_CONFLICT");
        }
        if (input.principal) {
          // A duplicate-key wait can also outlast a session's expiry. Reuse the
          // already-held context locks before committing an account submission.
          const [current] = await tx.$queryRaw<{ access: string }[]>`
            SELECT public.mq_lock_comment_context(${input.principal.sessionId},${input.principal.userId},${storyId}::uuid) AS access`;
          if (current.access === "unauthenticated") throw new CommentOperationError("COMMENT_UNAUTHENTICATED");
        }
        return { receiptId: receipt.id };
      });
    },

    listAdmin(input: CommentPage & { state?: CommentState; storyId?: string; commentId?: string }) {
      return operation(async () => {
        const state = input.state ? Prisma.sql`AND c.state=${input.state}::public."CommentState"` : Prisma.empty;
        const story = input.storyId ? Prisma.sql`AND c.story_id=${input.storyId}::uuid` : Prisma.empty;
        const comment = input.commentId ? Prisma.sql`AND c.id=${input.commentId}::uuid` : Prisma.empty;
        const cursor = input.cursor ? Prisma.sql`AND (c.created_at,c.id)<(${input.cursor.createdAt}::timestamptz,${input.cursor.id}::uuid)` : Prisma.empty;
        const [result] = await tx.$queryRaw<{ count: number; items: AdminComment[] }[]>`
          SELECT (SELECT count(*)::int FROM public.story_comment c WHERE true ${state} ${story} ${comment}) AS count,
            COALESCE((SELECT jsonb_agg(selected ORDER BY selected."createdAt" DESC,selected.id DESC) FROM (
              SELECT c.id,c.story_id AS "storyId",c.body,COALESCE(u.username,'匿名访客') AS author,c.created_at AS "createdAt",
                c.state,c.version,c.moderated_at AS "moderatedAt",c.approved_at AS "approvedAt",
                r.title AS "storyDraftTitle",s.state AS "storyState"
              FROM public.story_comment c LEFT JOIN public."User" u ON u.id=c.user_id
              JOIN public.story s ON s.id=c.story_id
              JOIN public.story_revision r ON r.story_id=s.id AND r.id=s.draft_revision_id
              WHERE true ${state} ${story} ${comment} ${cursor} ORDER BY c.created_at DESC,c.id DESC LIMIT ${input.limit + 1}
            ) selected),'[]'::jsonb) AS items`;
        const items = result.items.slice(0, input.limit).map(item => ({ ...item, createdAt: new Date(item.createdAt).toISOString(),
          moderatedAt: item.moderatedAt ? new Date(item.moderatedAt).toISOString() : null,
          approvedAt: item.approvedAt ? new Date(item.approvedAt).toISOString() : null }));
        const last = items.at(-1);
        return { items, count: result.count, nextCursor: result.items.length > input.limit && last ? { createdAt: last.createdAt, id: last.id } : null };
      });
    },

    moderate(commentId: string, input: { action: ModerationAction; expectedVersion: number; principal: CommentPrincipal }, key: Buffer) {
      return operation(async () => {
        await assertCommentDatabasePrivileges(tx);
        const [comment] = await tx.$queryRaw<{ storyId: string }[]>`SELECT story_id AS "storyId" FROM public.story_comment WHERE id=${commentId}::uuid`;
        if (!comment) throw new CommentOperationError("COMMENT_NOT_FOUND");
        const [identity] = await tx.$queryRaw<{ database: string; actor: string; transaction: string }[]>`
          SELECT current_database() AS database,session_user::text AS actor,pg_current_xact_id()::text AS transaction`;
        const payload = JSON.stringify(["mq-comment-moderation-v1", identity.database, identity.actor, identity.transaction,
          input.principal.sessionId, input.principal.userId, input.action, comment.storyId, commentId.toLowerCase(), String(input.expectedVersion)]);
        const signature = createHmac("sha256", key).update(payload, "utf8").digest();
        await tx.$queryRaw`SELECT public.mq_apply_comment_moderation(${payload}::text,${signature}::bytea)`;
        const [updated] = await tx.$queryRaw<{ id: string; state: CommentState; version: number; moderatedAt: Date; approvedAt: Date | null }[]>`
          SELECT id,state,version,moderated_at AS "moderatedAt",approved_at AS "approvedAt" FROM public.story_comment WHERE id=${commentId}::uuid`;
        return { id: updated.id, state: updated.state, version: updated.version,
          moderatedAt: updated.moderatedAt.toISOString(), approvedAt: updated.approvedAt?.toISOString() ?? null };
      });
    },
  };
}
