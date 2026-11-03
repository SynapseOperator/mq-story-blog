import { EDITOR_SYNTHETIC_IMAGE, type DraftBlock, type DraftContent, type DraftDetail,
  type DraftList, type DraftSummary, type EditorDocument, type FailureKind } from "./types.ts";
import { toRevision, validateDocument } from "./state.ts";

// Fixed, user-facing errors. Never forward server JSON, SQL details or fetch
// exceptions into the editor, console or a diagnostic persistence mechanism.
const messages: Record<FailureKind, string> = {
  validation: "内容未通过校验，请检查标题、段落和图片说明。",
  conflict: "服务器内容已变化，或篝火故事已存在。请读取服务器内容后手动处理。",
  uncertain: "保存结果尚未确认。请先核对服务器草稿，不要直接重复提交。",
  denied: "管理权限已失效或当前账号无权操作。你的本地编辑仍然保留。",
  retryable: "暂时无法读取或处理请求，请稍后重试。你的本地编辑仍然保留。",
  cancelled: "本次读取已取消。",
};

export class DraftClientError extends Error {
  readonly kind: FailureKind;
  readonly status: number | null;
  constructor(kind: FailureKind, status: number | null = null) {
    super(messages[kind]);
    this.name = "DraftClientError";
    this.kind = kind;
    this.status = status;
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cursorPattern = /^[A-Za-z0-9_-]{1,200}$/;
function malformed(): never { throw new Error("Invalid draft response"); }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) return malformed();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) return malformed();
  return value;
}
function integer(value: unknown, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) return malformed();
  return value as number;
}
function summary(value: unknown): DraftSummary {
  const row = object(value, ["id", "slug", "kind", "state", "version", "draftTitle", "hasUnpublishedChanges", "updatedAt"]);
  const id = text(row.id, 36), slug = text(row.slug, 120), title = text(row.draftTitle, 160), updatedAt = text(row.updatedAt, 24);
  if (!uuid.test(id) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
    || !["STAR", "CAMPFIRE"].includes(row.kind as string)
    || !["DRAFT", "PUBLISHED", "WITHDRAWN"].includes(row.state as string)
    || typeof row.hasUnpublishedChanges !== "boolean" || title !== title.trim()
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(updatedAt)
    || !Number.isFinite(Date.parse(updatedAt)) || new Date(updatedAt).toISOString() !== updatedAt) return malformed();
  return { id, slug, kind: row.kind as DraftSummary["kind"], state: row.state as DraftSummary["state"],
    version: integer(row.version), draftTitle: title, hasUnpublishedChanges: row.hasUnpublishedChanges, updatedAt };
}
function content(value: unknown): DraftContent {
  const raw = object(value, ["version", "blocks"]);
  if (![1, 2].includes(raw.version as number) || !Array.isArray(raw.blocks) || raw.blocks.length < 1 || raw.blocks.length > 200) return malformed();
  const blocks: DraftBlock[] = raw.blocks.map((value: unknown) => {
    const row = object(value, ["type"], ["text", "style", "src", "assetId", "alt", "caption"]);
    if (row.type === "paragraph") {
      object(row, ["type", "text"], ["style"]);
      const paragraph = { type: "paragraph" as const, text: text(row.text, 10_000) };
      if (Object.hasOwn(row, "style")) {
        if (!["normal", "emphasis", "strong"].includes(row.style as string)) return malformed();
        return { ...paragraph, style: row.style as "normal" | "emphasis" | "strong" };
      }
      return paragraph;
    }
    if (row.type === "image") {
      if (raw.version === 2) {
        object(row, ["type", "assetId", "alt"], ["caption"]);
        if (typeof row.assetId !== "string" || !uuid.test(row.assetId)) return malformed();
        return { type: "image", assetId: row.assetId.toLowerCase(), alt: text(row.alt, 300),
          ...(Object.hasOwn(row, "caption") ? { caption: text(row.caption, 1000) } : {}) };
      }
      object(row, ["type", "src", "alt"], ["caption"]);
      if (row.src !== EDITOR_SYNTHETIC_IMAGE) return malformed();
      return { type: "image", src: row.src, alt: text(row.alt, 300),
        ...(Object.hasOwn(row, "caption") ? { caption: text(row.caption, 1000) } : {}) };
    }
    return malformed();
  });
  const result = { version: raw.version, blocks } as DraftContent;
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 256 * 1024) return malformed();
  return result;
}
function detail(value: unknown): DraftDetail {
  const raw = object(value, ["story", "draft"]), story = summary(raw.story), draft = object(raw.draft, ["title", "content"]);
  const title = text(draft.title, 160);
  if (title !== story.draftTitle) return malformed();
  return { story, draft: { title, content: content(draft.content) } };
}
function list(value: unknown): DraftList {
  const raw = object(value, ["items", "nextCursor"]);
  if (!Array.isArray(raw.items) || raw.items.length > 50
    || (raw.nextCursor !== null && (typeof raw.nextCursor !== "string" || !cursorPattern.test(raw.nextCursor)))) return malformed();
  const items = raw.items.map(summary);
  if (new Set(items.map(item => item.id)).size !== items.length) return malformed();
  return { items, nextCursor: raw.nextCursor as string | null };
}

function httpFailure(status: number, write: boolean): DraftClientError {
  if (status === 401 || status === 403) return new DraftClientError("denied", status);
  if ([400, 413, 415, 405].includes(status)) return new DraftClientError("validation", status);
  if (status === 409) return new DraftClientError("conflict", status);
  // 404/429 are explicit rejections, not evidence that a write committed.
  if (status === 404 || status === 429) return new DraftClientError("retryable", status);
  return new DraftClientError(write ? "uncertain" : "retryable", status);
}

/** Four existing private APIs only. Writes are never retried or cancelled by
 * navigation; after an unknown result the state machine requires reconciliation. */
export function createDraftApi(fetcher: typeof fetch = globalThis.fetch) {
  async function request<T>(path: string, parse: (value: unknown) => T, options: {
    method?: "POST" | "PUT"; body?: unknown; signal?: AbortSignal;
  } = {}): Promise<T> {
    const write = options.method !== undefined;
    const timeout = AbortSignal.timeout(15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await fetcher(path, { method: options.method ?? "GET", credentials: "same-origin", cache: "no-store",
        redirect: "error", signal, headers: { Accept: "application/json", ...(write ? { "Content-Type": "application/json" } : {}) },
        ...(write ? { body: JSON.stringify(options.body) } : {}) });
      if (!response.ok) throw httpFailure(response.status, write);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return malformed();
      const body = await response.text();
      if (body.length > 400 * 1024) return malformed();
      return parse(JSON.parse(body));
    } catch (error) {
      if (error instanceof DraftClientError) throw error;
      if (!write && options.signal?.aborted) throw new DraftClientError("cancelled");
      throw new DraftClientError(write ? "uncertain" : "retryable");
    }
  }
  function validId(id: string): void {
    if (!uuid.test(id)) throw new DraftClientError("validation");
  }
  function validDocument(document: EditorDocument): void {
    if (validateDocument(document) !== null) throw new DraftClientError("validation");
  }
  return {
    list(cursor: string | null = null, signal?: AbortSignal): Promise<DraftList> {
      if (cursor !== null && !cursorPattern.test(cursor)) return Promise.reject(new DraftClientError("validation"));
      return request(`/api/admin/stories?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, list, { signal });
    },
    async get(id: string, signal?: AbortSignal): Promise<DraftDetail> {
      validId(id);
      return request(`/api/admin/stories/${id}/draft`, value => {
        const result = detail(value);
        if (result.story.id !== id) return malformed();
        return result;
      }, { signal });
    },
    async create(document: EditorDocument): Promise<DraftSummary> {
      validDocument(document);
      return request("/api/admin/stories", value => summary(object(value, ["story"]).story),
        { method: "POST", body: { kind: document.kind, ...toRevision(document) } });
    },
    async save(id: string, expectedVersion: number, document: EditorDocument): Promise<DraftSummary> {
      validId(id); validDocument(document);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= 2_147_483_647) throw new DraftClientError("validation");
      return request(`/api/admin/stories/${id}/draft`, value => {
        const result = summary(object(value, ["story"]).story);
        if (result.id !== id) return malformed();
        return result;
      }, { method: "PUT", body: { expectedVersion, ...toRevision(document) } });
    },
  };
}

export const draftApi = createDraftApi();
