export type CommentState = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
export type AdminComment = {
  id: string; storyId: string; storyDraftTitle: string; storyState: "DRAFT" | "PUBLISHED" | "WITHDRAWN";
  body: string; author: string; createdAt: string; state: CommentState; version: number;
  moderatedAt: string | null; approvedAt: string | null;
};
export type ModerationAction = "approve" | "reject" | "withdraw";
type Moderated = Pick<AdminComment, "id" | "state" | "version" | "moderatedAt" | "approvedAt">;
type Page = { items: AdminComment[]; count: number; nextCursor: string | null };
type FailureKind = "denied" | "conflict" | "uncertain" | "unavailable" | "rejected" | "cancelled";
const messages: Record<FailureKind, string> = {
  denied: "管理权限已失效，请返回 MQ 重新确认账号。",
  conflict: "这条留言已被其他操作改变。请重新读取后再决定。",
  uncertain: "审核结果尚未确认。请重新读取此留言，不要重复提交。",
  unavailable: "暂时无法读取留言，请稍后重试。",
  rejected: "本次操作未完成，请重新读取此留言后再决定。",
  cancelled: "本次读取已取消。",
};
export class CommentAdminClientError extends Error {
  readonly kind: FailureKind;
  constructor(kind: FailureKind) { super(messages[kind]); this.name = "CommentAdminClientError"; this.kind = kind; }
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const states = ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"];
function invalid(): never { throw new Error("Invalid moderation response"); }
function object(value: unknown, fields: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalid();
  return value as Record<string, unknown>;
}
function date(value: unknown, nullable = false): value is string | null {
  return nullable && value === null || typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function moderation(value: unknown): Moderated {
  const row = object(value, ["id", "state", "version", "moderatedAt", "approvedAt"]);
  if (typeof row.id !== "string" || !uuid.test(row.id) || !states.includes(row.state as string)
    || !Number.isSafeInteger(row.version) || (row.version as number) < 0 || (row.version as number) > 2_147_483_647
    || !date(row.moderatedAt, true) || !date(row.approvedAt, true)) invalid();
  return row as Moderated;
}
function comment(value: unknown): AdminComment {
  const row = object(value, ["id", "storyId", "storyDraftTitle", "storyState", "body", "author", "createdAt", "state", "version", "moderatedAt", "approvedAt"]);
  moderation({ id: row.id, state: row.state, version: row.version, moderatedAt: row.moderatedAt, approvedAt: row.approvedAt });
  if (typeof row.storyId !== "string" || !uuid.test(row.storyId)
    || typeof row.storyDraftTitle !== "string" || !row.storyDraftTitle.trim() || row.storyDraftTitle.length > 160
    || !["DRAFT", "PUBLISHED", "WITHDRAWN"].includes(row.storyState as string)
    || typeof row.body !== "string" || !row.body.trim() || [...row.body].length > 500
    || typeof row.author !== "string" || !row.author || row.author.length > 64 || !date(row.createdAt)) invalid();
  return row as AdminComment;
}

export function createCommentAdminApi(fetcher: typeof fetch = globalThis.fetch) {
  async function request<T>(path: string, parse: (value: unknown) => T, options: { body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const write = options.body !== undefined;
    const timeout = AbortSignal.timeout(15_000);
    try {
      const response = await fetcher(path, { method: write ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { Accept: "application/json", ...(write ? { "Content-Type": "application/json" } : {}) },
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        ...(write ? { body: JSON.stringify(options.body) } : {}) });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new CommentAdminClientError("denied");
        if (response.status === 409) throw new CommentAdminClientError("conflict");
        if ([400, 404, 405, 413, 415, 429].includes(response.status)) throw new CommentAdminClientError("rejected");
        throw new CommentAdminClientError(write ? "uncertain" : "unavailable");
      }
      if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) invalid();
      const body = await response.text();
      if (body.length > 200_000) invalid();
      return parse(JSON.parse(body));
    } catch (error) {
      if (error instanceof CommentAdminClientError) throw error;
      if (!write && options.signal?.aborted) throw new CommentAdminClientError("cancelled");
      throw new CommentAdminClientError(write ? "uncertain" : "unavailable");
    }
  }
  return {
    list(filter: { state: CommentState; storyId: string; cursor?: string | null }, signal?: AbortSignal) {
      const search = new URLSearchParams({ state: filter.state, limit: "20" });
      if (filter.storyId) search.set("storyId", filter.storyId);
      if (filter.cursor) search.set("cursor", filter.cursor);
      return request<Page>(`/api/admin/comments?${search}`, value => {
        const page = object(value, ["items", "count", "nextCursor"]);
        if (!Array.isArray(page.items) || page.items.length > 20 || !Number.isSafeInteger(page.count) || (page.count as number) < 0
          || page.nextCursor !== null && (typeof page.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(page.nextCursor))) invalid();
        const items = page.items.map(comment);
        if (new Set(items.map(item => item.id)).size !== items.length
          || items.some(item => item.state !== filter.state || filter.storyId && item.storyId !== filter.storyId)) invalid();
        return { items, count: page.count as number, nextCursor: page.nextCursor as string | null };
      }, { signal });
    },
    get(id: string, signal?: AbortSignal) {
      return request(`/api/admin/comments?commentId=${encodeURIComponent(id)}`, value => {
        const result = comment(object(value, ["comment"]).comment);
        if (result.id !== id) invalid();
        return result;
      }, { signal });
    },
    moderate(item: AdminComment, action: ModerationAction) {
      return request(`/api/admin/comments/${item.id}/moderate`, value => {
        const result = moderation(object(value, ["comment"]).comment);
        const expected = { approve: "APPROVED", reject: "REJECTED", withdraw: "WITHDRAWN" }[action];
        if (result.id !== item.id || result.version !== item.version + 1 || result.state !== expected || result.moderatedAt === null) invalid();
        return result;
      }, { body: { action, expectedVersion: item.version } });
    },
  };
}
export const commentAdminApi = createCommentAdminApi();
