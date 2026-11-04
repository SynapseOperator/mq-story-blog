import { clientIdentity, type AuthConfiguration } from "../auth/policy.ts";
import { isPublicStoryId } from "../stories/public-service.ts";

export type LikeErrorCode = "LIKES_VALIDATION" | "LIKES_NOT_FOUND" | "LIKES_UNAUTHENTICATED"
  | "LIKES_UNAVAILABLE" | "LIKES_ORIGIN_REJECTED" | "LIKES_PROXY_REJECTED" | "LIKES_RATE_LIMITED"
  | "LIKES_JSON_REQUIRED" | "LIKES_BODY_TOO_LARGE";
const statuses: Record<LikeErrorCode, number> = {
  LIKES_VALIDATION: 400, LIKES_NOT_FOUND: 404, LIKES_UNAUTHENTICATED: 401,
  LIKES_UNAVAILABLE: 503, LIKES_ORIGIN_REJECTED: 403, LIKES_PROXY_REJECTED: 403, LIKES_RATE_LIMITED: 429,
  LIKES_JSON_REQUIRED: 415, LIKES_BODY_TOO_LARGE: 413,
};
export class LikeOperationError extends Error {
  readonly code: LikeErrorCode;
  readonly status: number;
  constructor(code: LikeErrorCode) {
    super(code);
    this.name = "LikeOperationError";
    this.code = code;
    this.status = statuses[code];
  }
}

export function inspectLikeTarget(request: Request, id: string) {
  const url = new URL(request.url);
  if (!isPublicStoryId(id)) throw new LikeOperationError("LIKES_NOT_FOUND");
  if (url.pathname !== `/api/stories/${id}/likes` || url.search
    || request.headers.has("x-http-method-override") || request.headers.has("x-method-override")) {
    throw new LikeOperationError("LIKES_VALIDATION");
  }
}

export function inspectLikeOrigin(request: Request, config: AuthConfiguration) {
  const client = clientIdentity(request, config);
  if (!client) throw new LikeOperationError("LIKES_PROXY_REJECTED");
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin !== null && origin !== config.origin)
    || (request.method !== "GET" && origin !== config.origin)) throw new LikeOperationError("LIKES_ORIGIN_REJECTED");
  return client;
}

export const LIKE_BODY_LIMIT = 256;
/** Same bounded stream/UTF-8/timeout policy as existing draft writes. There is
 * deliberately no identity or desired-state field: PUT/DELETE express intent. */
export async function readLikeBody(request: Request): Promise<void> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")
    || ![null, "identity"].includes(request.headers.get("content-encoding"))) throw new LikeOperationError("LIKES_JSON_REQUIRED");
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > LIKE_BODY_LIMIT)) throw new LikeOperationError("LIKES_BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new LikeOperationError("LIKES_VALIDATION");
  let size = 0;
  const parts: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new LikeOperationError("LIKES_VALIDATION")); }, 5000);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LIKE_BODY_LIMIT) throw new LikeOperationError("LIKES_BODY_TOO_LARGE");
      parts.push(next.value);
    }
    const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) {
      throw new LikeOperationError("LIKES_VALIDATION");
    }
  } catch (error) {
    if (error instanceof LikeOperationError) throw error;
    throw new LikeOperationError("LIKES_VALIDATION");
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
