import { createHash } from "node:crypto";
import { AdminAccessError } from "../admin/policy.ts";
import { clientIdentity, type AuthConfiguration } from "../auth/policy.ts";

export type CommentErrorCode = "COMMENT_VALIDATION" | "COMMENT_NOT_FOUND" | "COMMENT_CONFLICT"
  | "COMMENT_INVALID_STATE" | "COMMENT_UNAUTHENTICATED" | "COMMENT_FORBIDDEN" | "COMMENT_UNAVAILABLE"
  | "COMMENT_ORIGIN_REJECTED" | "COMMENT_PROXY_REJECTED" | "COMMENT_RATE_LIMITED"
  | "COMMENT_JSON_REQUIRED" | "COMMENT_BODY_TOO_LARGE";
const statuses: Record<CommentErrorCode, number> = {
  COMMENT_VALIDATION: 400, COMMENT_NOT_FOUND: 404, COMMENT_CONFLICT: 409, COMMENT_INVALID_STATE: 409,
  COMMENT_UNAUTHENTICATED: 401, COMMENT_FORBIDDEN: 403, COMMENT_UNAVAILABLE: 503,
  COMMENT_ORIGIN_REJECTED: 403, COMMENT_PROXY_REJECTED: 403, COMMENT_RATE_LIMITED: 429,
  COMMENT_JSON_REQUIRED: 415, COMMENT_BODY_TOO_LARGE: 413,
};

/** Preserve domain failures through withAdmin so its transaction rolls back
 * before the HTTP boundary returns a fixed public code. */
export class CommentOperationError extends AdminAccessError {
  readonly commentCode: CommentErrorCode;
  constructor(code: CommentErrorCode) {
    super("ADMIN_REQUEST_REJECTED", statuses[code]);
    this.commentCode = code;
  }
}

export type CommentState = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
export type CommentCursor = { createdAt: string; id: string };
export type CommentPage = { limit: number; cursor?: CommentCursor };
export type CommentModeration = { action: "approve" | "reject" | "withdraw"; expectedVersion: number };
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function invalid(): never { throw new CommentOperationError("COMMENT_VALIDATION"); }
function object(input: unknown, keys: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) invalid();
  return input as Record<string, unknown>;
}

export function commentId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new CommentOperationError("COMMENT_NOT_FOUND");
  return value.toLowerCase();
}

export function inspectCommentTarget(request: Request, expectedPath: string, allowQuery: boolean) {
  const url = new URL(request.url);
  if (url.pathname !== expectedPath || (!allowQuery && url.search)
    || request.headers.has("x-http-method-override") || request.headers.has("x-method-override")) invalid();
  return url.searchParams;
}

export function inspectCommentOrigin(request: Request, config: AuthConfiguration) {
  const client = clientIdentity(request, config);
  if (!client) throw new CommentOperationError("COMMENT_PROXY_REJECTED");
  if (request.headers.get("origin") !== config.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new CommentOperationError("COMMENT_ORIGIN_REJECTED");
  }
  return client;
}

export function commentSubmission(input: unknown): { body: string; identity: "anonymous" | "account" } {
  const value = object(input, ["body", "identity"]);
  if (typeof value.body !== "string" || !value.body.isWellFormed()
    || /\p{Cc}/u.test(value.body.replace(/[\t\n\r]/g, ""))
    || (value.identity !== "anonymous" && value.identity !== "account")) invalid();
  const body = value.body.trim();
  const length = [...body].length;
  if (length < 1 || length > 500) invalid();
  return { body, identity: value.identity };
}

export function commentIdempotencyHash(value: string | null) {
  if (value === null || !uuid.test(value)) invalid();
  return createHash("sha256").update(value.toLowerCase(), "utf8").digest("hex");
}

export function commentPage(search: URLSearchParams, admin = false): CommentPage & { state?: CommentState; storyId?: string } {
  const allowed = admin ? ["limit", "cursor", "state", "storyId"] : ["limit", "cursor"];
  for (const key of search.keys()) if (!allowed.includes(key) || search.getAll(key).length !== 1) invalid();
  const rawLimit = search.get("limit") ?? "20";
  if (!/^[1-9][0-9]?$/.test(rawLimit) || Number(rawLimit) > 50) invalid();
  const page: CommentPage & { state?: CommentState; storyId?: string } = { limit: Number(rawLimit) };
  if (admin) {
    const state = search.get("state") ?? "PENDING";
    if (!["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"].includes(state)) invalid();
    page.state = state as CommentState;
    const storyId = search.get("storyId");
    if (storyId !== null) { if (!uuid.test(storyId)) invalid(); page.storyId = storyId.toLowerCase(); }
  }
  const token = search.get("cursor");
  if (token === null) return page;
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(token)) invalid();
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) invalid();
    const cursor = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), ["createdAt", "id"]);
    if (typeof cursor.id !== "string" || !uuid.test(cursor.id)
      || typeof cursor.createdAt !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.createdAt)) invalid();
    const date = new Date(cursor.createdAt);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== cursor.createdAt) invalid();
    page.cursor = { createdAt: cursor.createdAt, id: cursor.id.toLowerCase() };
    return page;
  } catch { return invalid(); }
}

export function encodeCommentCursor(cursor: { createdAt: Date | string; id: string } | null) {
  return cursor ? Buffer.from(JSON.stringify({ createdAt: new Date(cursor.createdAt).toISOString(), id: cursor.id })).toString("base64url") : null;
}

export function adminCommentRead(search: URLSearchParams) {
  if (!search.has("commentId")) return { page: commentPage(search, true) };
  const id = search.get("commentId");
  if ([...search.keys()].length !== 1 || id === null || !uuid.test(id)) invalid();
  return { commentId: id.toLowerCase() };
}

export function commentModeration(input: unknown): CommentModeration {
  const value = object(input, ["action", "expectedVersion"]);
  if (typeof value.action !== "string" || !["approve", "reject", "withdraw"].includes(value.action)
    || !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0
    || (value.expectedVersion as number) >= 2_147_483_647) invalid();
  return { action: value.action as CommentModeration["action"], expectedVersion: value.expectedVersion as number };
}

export function requireCommentsEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.MQ_COMMENTS_ENABLED !== "true") throw new CommentOperationError("COMMENT_UNAVAILABLE");
}

/** Only called inside the verified moderation callback. No auth/publishing key fallback. */
export function commentSigningKey(env: NodeJS.ProcessEnv = process.env) {
  requireCommentsEnabled(env);
  const key = env.MQ_COMMENT_SIGNING_KEY;
  if (!/^[a-f0-9]{64}$/i.test(key ?? "")
    || [env.AUTH_SECRET, env.BETTER_AUTH_SECRET, env.MQ_AUTH_SECRET, env.MQ_PUBLISH_SIGNING_KEY]
      .some(other => other !== undefined && other.toLowerCase() === key!.toLowerCase())) {
    throw new CommentOperationError("COMMENT_UNAVAILABLE");
  }
  return Buffer.from(key!, "hex");
}

// Enough for 500 supplementary code points even when JSON escapes each surrogate.
export const COMMENT_BODY_LIMIT = 8 * 1024;
export async function readCommentBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")
    || ![null, "identity"].includes(request.headers.get("content-encoding"))) throw new CommentOperationError("COMMENT_JSON_REQUIRED");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > COMMENT_BODY_LIMIT)) throw new CommentOperationError("COMMENT_BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return invalid();
  let size = 0;
  const parts: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new CommentOperationError("COMMENT_VALIDATION")); }, 5000);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > COMMENT_BODY_LIMIT) throw new CommentOperationError("COMMENT_BODY_TOO_LARGE");
      parts.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  } catch (error) {
    if (error instanceof CommentOperationError) throw error;
    return invalid();
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
