import { validateStoryContent, validateStoryTitle, ContentValidationError, SYNTHETIC_STORY_IMAGES } from "../../stories/content.ts";
import { AdminAccessError } from "../policy.ts";

export type DraftErrorCode = "DRAFT_VALIDATION" | "DRAFT_NOT_FOUND" | "DRAFT_CONFLICT" | "DRAFT_INVALID_STATE"
  | "DRAFT_BODY_TOO_LARGE" | "DRAFT_JSON_REQUIRED" | "DRAFT_METHOD_NOT_ALLOWED";
const statuses: Record<DraftErrorCode, number> = {
  DRAFT_VALIDATION: 400, DRAFT_NOT_FOUND: 404, DRAFT_CONFLICT: 409, DRAFT_INVALID_STATE: 409,
  DRAFT_BODY_TOO_LARGE: 413, DRAFT_JSON_REQUIRED: 415, DRAFT_METHOD_NOT_ALLOWED: 405,
};

/** Trusted server exception, never constructed from a caller-supplied status.
 * The existing withAdmin preserves AdminAccessError after transaction rollback;
 * using this subtype keeps its reviewed authentication/locking code unchanged. */
export class DraftOperationError extends AdminAccessError {
  readonly draftCode: DraftErrorCode;
  constructor(draftCode: DraftErrorCode) {
    super("ADMIN_REQUEST_REJECTED", statuses[draftCode]);
    this.draftCode = draftCode;
  }
}

export const DRAFT_BODY_LIMIT = 300 * 1024;
export type DraftCursor = { createdAt: string; id: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new DraftOperationError("DRAFT_VALIDATION"); }
export function draftId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) invalid();
  return value;
}
function object(input: unknown, allowed: string[]) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !allowed.includes(key))
    || allowed.some(key => !Object.hasOwn(input, key))) invalid();
  return input as Record<string, unknown>;
}
function revision(input: Record<string, unknown>) {
  try {
    const title = validateStoryTitle(input.title);
    const content = validateStoryContent(input.content);
    // This increment stores existing same-origin references only. It neither
    // fetches URLs nor establishes media ownership/access rules (P2-09).
    if (content.blocks.some(block => block.type === "image" && !SYNTHETIC_STORY_IMAGES.includes(block.src))) invalid();
    return { title, content };
  } catch (error) {
    if (error instanceof ContentValidationError) invalid();
    throw error;
  }
}
export function draftCreate(input: unknown) {
  const value = object(input, ["kind", "title", "content"]);
  if (value.kind !== "STAR" && value.kind !== "CAMPFIRE") invalid();
  return { kind: value.kind as "STAR" | "CAMPFIRE", ...revision(value) };
}
export function draftSave(input: unknown) {
  const value = object(input, ["expectedVersion", "title", "content"]);
  if (!Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0
    || (value.expectedVersion as number) >= 2_147_483_647) invalid();
  return { expectedVersion: value.expectedVersion as number, ...revision(value) };
}
export function draftPage(search: URLSearchParams): { limit: number; cursor?: DraftCursor } {
  for (const key of search.keys()) {
    if (!["limit", "cursor"].includes(key) || search.getAll(key).length !== 1) invalid();
  }
  const limit = search.get("limit") ?? "20";
  if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 50) invalid();
  const token = search.get("cursor");
  if (token === null) return { limit: Number(limit) };
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(token)) invalid();
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) invalid();
    const value = object(JSON.parse(bytes.toString("utf8")), ["createdAt", "id"]);
    const id = draftId(value.id);
    if (typeof value.createdAt !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt)) invalid();
    const createdAt = new Date(value.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== value.createdAt) invalid();
    return { limit: Number(limit), cursor: { createdAt: value.createdAt, id } };
  } catch { return invalid(); }
}
export function encodeDraftCursor(cursor: { createdAt: Date | string; id: string } | null) {
  return cursor ? Buffer.from(JSON.stringify({ createdAt: new Date(cursor.createdAt).toISOString(), id: cursor.id })).toString("base64url") : null;
}

/** Read the actual byte stream once, with a bound before JSON parsing. No
 * connection or authorization lock is held while waiting for a client body. */
export async function readDraftBody(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")
    || ![null, "identity"].includes(request.headers.get("content-encoding"))) {
    throw new DraftOperationError("DRAFT_JSON_REQUIRED");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > DRAFT_BODY_LIMIT)) {
    throw new DraftOperationError("DRAFT_BODY_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) return invalid();
  let size = 0;
  const parts: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new DraftOperationError("DRAFT_VALIDATION")); }, 5000);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > DRAFT_BODY_LIMIT) throw new DraftOperationError("DRAFT_BODY_TOO_LARGE");
      parts.push(next.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  } catch (error) {
    if (error instanceof DraftOperationError) throw error;
    return invalid();
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
