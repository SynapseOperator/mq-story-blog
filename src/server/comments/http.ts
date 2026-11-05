import { createAuthDatabaseClient } from "../auth/database.ts";
import { authConfiguration } from "../auth/policy.ts";
import { readVerifiedSession } from "../auth/service.ts";
import { withAdmin } from "../admin/access.ts";
import { AdminAccessError } from "../admin/policy.ts";
import { createStoryCommentOperations } from "./service.ts";
import { consumeCommentLimit } from "./rate-limit.ts";
import { CommentOperationError, commentId, commentIdempotencyHash, commentModeration, commentPage,
  commentSigningKey, commentSubmission, encodeCommentCursor, inspectCommentOrigin, inspectCommentTarget,
  readCommentBody, requireCommentsEnabled } from "./policy.ts";

const headers = { "cache-control": "private, no-store, max-age=0", pragma: "no-cache",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", vary: "Cookie" };
let database: ReturnType<typeof createAuthDatabaseClient> | undefined;
function reply(request: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status, headers: { ...headers, "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export async function handleStoryComments(request: Request, id: string) {
  try {
    if (!["GET", "POST"].includes(request.method)) return reply(request, { code: "COMMENT_METHOD_NOT_ALLOWED" }, 405, { allow: "GET, POST" });
    const storyId = commentId(id);
    const reading = request.method === "GET";
    const search = inspectCommentTarget(request, `/api/stories/${id}/comments`, reading);
    if (reading) {
      const page = commentPage(search);
      if (!process.env.DATABASE_URL) throw new CommentOperationError("COMMENT_UNAVAILABLE");
      const db = database ??= createAuthDatabaseClient(process.env.DATABASE_URL);
      // Public reads deliberately do not initialize authentication or inspect cookies.
      const result = await createStoryCommentOperations(db).listPublic(storyId, page);
      return reply(request, { ...result, nextCursor: encodeCommentCursor(result.nextCursor) });
    }
    requireCommentsEnabled();
    const config = authConfiguration();
    const client = inspectCommentOrigin(request, config);
    const input = commentSubmission(await readCommentBody(request));
    const idempotencyKeyHash = commentIdempotencyHash(request.headers.get("idempotency-key"));
    const db = database ??= createAuthDatabaseClient(config.databaseURL);
    const verified = await readVerifiedSession(request.headers);
    // A signed-in user choosing anonymous display still consumes their account quota.
    const limit = await consumeCommentLimit(db, config.secret, client, verified?.user.id);
    if (!limit.allowed) return reply(request, { code: "COMMENT_RATE_LIMITED" }, 429, { "retry-after": String(limit.retryAfter) });
    if (input.identity === "account" && !verified) throw new CommentOperationError("COMMENT_UNAUTHENTICATED");
    const principal = input.identity === "account" && verified
      ? { userId: verified.user.id, sessionId: verified.sessionId } : null;
    const receipt = await db.$transaction(tx => createStoryCommentOperations(tx).submit(storyId, {
      principal, body: input.body, idempotencyKeyHash,
    }));
    // A replay has the same response even if moderation has since changed state.
    return reply(request, { receiptId: receipt.receiptId }, 202);
  } catch (error) {
    if (error instanceof CommentOperationError) return reply(request, { code: error.commentCode }, error.status);
    console.error("MQ_STORY_COMMENTS_UNAVAILABLE");
    return reply(request, { code: "COMMENT_UNAVAILABLE" }, 503);
  }
}

export async function handleAdminComments(request: Request, id?: string) {
  try {
    const allowed = id === undefined ? "GET" : "POST";
    if (request.method !== allowed) return reply(request, { code: "COMMENT_METHOD_NOT_ALLOWED" }, 405, { allow: allowed });
    const comment = id === undefined ? undefined : commentId(id);
    const search = inspectCommentTarget(request, id === undefined ? "/api/admin/comments" : `/api/admin/comments/${id}/moderate`, id === undefined);
    const page = id === undefined ? commentPage(search, true) : null;
    const input = id === undefined ? null : commentModeration(await readCommentBody(request));
    const data = await withAdmin(request, async (tx, principal) => {
      const operations = createStoryCommentOperations(tx);
      if (page) {
        const result = await operations.listAdmin(page);
        return { ...result, nextCursor: encodeCommentCursor(result.nextCursor) };
      }
      // Key access and signing remain inside this exact authorization transaction.
      return { comment: await operations.moderate(comment!, { ...input!, principal }, commentSigningKey()) };
    });
    return reply(request, data);
  } catch (error) {
    if (error instanceof CommentOperationError) return reply(request, { code: error.commentCode }, error.status);
    if (error instanceof AdminAccessError) return reply(request, { code: error.code }, error.status);
    console.error("MQ_ADMIN_COMMENTS_UNAVAILABLE");
    return reply(request, { code: "COMMENT_UNAVAILABLE" }, 503);
  }
}
