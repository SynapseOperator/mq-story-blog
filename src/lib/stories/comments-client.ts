export type CommentIdentity = "anonymous" | "account";
export type PublicComment = { id: string; body: string; author: string; createdAt: string };
export type PublicCommentPage = { items: PublicComment[]; count: number; nextCursor: string | null };
export type CommentReceipt = { receiptId: string };

export class StoryCommentError extends Error {
  readonly status: number | null;
  readonly retryAfter: number | null;
  constructor(status: number | null = null, retryAfter: number | null = null) {
    super("STORY_COMMENTS_REQUEST_FAILED");
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StoryCommentError();
  return value as Record<string, unknown>;
}

/** Keep only the public DTO at the transport boundary. Bodies remain plain text. */
export function decodeStoryComments(value: unknown): PublicCommentPage {
  const data = object(value);
  if (!Array.isArray(data.items) || data.items.length > 50 || typeof data.count !== "number"
    || !Number.isSafeInteger(data.count) || data.count < 0
    || (data.nextCursor !== null && (typeof data.nextCursor !== "string"
      || !/^[A-Za-z0-9_-]{1,200}$/.test(data.nextCursor)))) throw new StoryCommentError();
  const ids = new Set<string>();
  const items = data.items.map(raw => {
    const item = object(raw);
    if (typeof item.id !== "string" || !uuid.test(item.id) || ids.has(item.id)
      || typeof item.body !== "string" || !item.body || typeof item.author !== "string" || !item.author
      || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new StoryCommentError();
    ids.add(item.id);
    return { id: item.id, body: item.body, author: item.author, createdAt: item.createdAt };
  });
  return { items, count: data.count, nextCursor: data.nextCursor as string | null };
}

export function decodeCommentReceipt(value: unknown): CommentReceipt {
  const data = object(value);
  if (typeof data.receiptId !== "string" || !uuid.test(data.receiptId)) throw new StoryCommentError();
  return { receiptId: data.receiptId };
}

async function response(path: string, options: RequestInit, signal: AbortSignal) {
  const result = await fetch(path, { ...options, credentials: "same-origin", cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!result.ok) {
    const seconds = Number(result.headers.get("retry-after"));
    throw new StoryCommentError(result.status, Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null);
  }
  return result;
}

export async function readStoryComments(storyId: string, cursor: string | null, signal: AbortSignal) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const result = await response(`/api/stories/${encodeURIComponent(storyId)}/comments${query}`, { method: "GET" }, signal);
  return decodeStoryComments(await result.json());
}

/** A retry is a caller action with the same frozen body/key; this function never retries. */
export async function submitStoryComment(storyId: string, input: { body: string; identity: CommentIdentity }, key: string, signal: AbortSignal) {
  const result = await response(`/api/stories/${encodeURIComponent(storyId)}/comments`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ body: input.body, identity: input.identity }),
  }, signal);
  if (result.status !== 202) throw new StoryCommentError();
  return decodeCommentReceipt(await result.json());
}
