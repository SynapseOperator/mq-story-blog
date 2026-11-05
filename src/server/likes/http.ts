import { createAuthDatabaseClient } from "../auth/database.ts";
import { authConfiguration } from "../auth/policy.ts";
import { consumeAuthLimit } from "../auth/rate-limit.ts";
import { readVerifiedSession } from "../auth/service.ts";
import { createStoryLikeOperations } from "./service.ts";
import { inspectLikeTarget, inspectLikeOrigin, readLikeBody, LikeOperationError } from "./policy.ts";

const headers = {
  "cache-control": "private, no-store, max-age=0", pragma: "no-cache", vary: "Cookie",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
};
let database: ReturnType<typeof createAuthDatabaseClient> | undefined;
function reply(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...headers, ...extra } });
}
export function rejectStoryLikeMethod() {
  return reply({ code: "LIKES_METHOD_NOT_ALLOWED" }, 405, { allow: "GET, PUT, DELETE" });
}

export async function handleStoryLikes(request: Request, id: string) {
  if (!["GET", "PUT", "DELETE"].includes(request.method)) return rejectStoryLikeMethod();
  try {
    inspectLikeTarget(request, id);
    const reading = request.method === "GET";
    const config = !reading || process.env.MQ_AUTH_ENABLED === "true" ? authConfiguration() : null;
    const client = config ? inspectLikeOrigin(request, config) : null;
    if (!reading) await readLikeBody(request);
    if (!process.env.DATABASE_URL) throw new LikeOperationError("LIKES_UNAVAILABLE");
    const db = database ??= createAuthDatabaseClient(process.env.DATABASE_URL);
    if (!reading && config && client) {
      const limit = await consumeAuthLimit(db, config.secret, "/story-likes", client);
      if (!limit.allowed) return reply({ code: "LIKES_RATE_LIMITED" }, 429, { "retry-after": String(limit.retryAfter) });
    }
    const verified = config ? await readVerifiedSession(request.headers) : null;
    const principal = verified ? { userId: verified.user.id, sessionId: verified.sessionId } : null;
    if (!reading && !principal) throw new LikeOperationError("LIKES_UNAUTHENTICATED");
    const result = reading ? await createStoryLikeOperations(db).read(id, principal)
      : await db.$transaction(tx => createStoryLikeOperations(tx).set(id, principal!, request.method === "PUT"));
    return reply(result);
  } catch (error) {
    if (error instanceof LikeOperationError) return reply({ code: error.code }, error.status);
    console.error("MQ_STORY_LIKES_UNAVAILABLE");
    return reply({ code: "LIKES_UNAVAILABLE" }, 503);
  }
}
