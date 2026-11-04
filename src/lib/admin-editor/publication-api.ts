import { DraftClientError } from "./api.ts";
import type { FailureKind, PublicationAck, PublicationAction, StarSlot } from "./types.ts";

export type { PublicationAck, PublicationAction, StarSlot } from "./types.ts";

const messages: Record<FailureKind, string> = {
  validation: "发布操作参数未通过校验，请核对当前故事与星位。",
  conflict: "服务器版本、发布状态或星位已变化。请重新读取后人工核对。",
  uncertain: "发布操作结果尚未确认。请先核对服务器状态，不要直接重复提交。",
  denied: "管理权限已失效或当前账号无权操作。你的本地编辑仍然保留。",
  retryable: "发布功能暂时不可用，请稍后重新核对。保存草稿与本地编辑不受影响。",
  cancelled: "本次星位读取已取消。",
};

export class PublicationClientError extends DraftClientError {
  constructor(kind: FailureKind, status: number | null = null) {
    super(kind, status);
    this.name = "PublicationClientError";
    this.message = messages[kind];
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slotPattern = /^[a-z0-9-]{1,64}$/;
function malformed(): never { throw new Error("Invalid publication response"); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return malformed();
  return value as Record<string, unknown>;
}
function storyState(value: unknown): PublicationAck["state"] {
  if (!["DRAFT", "PUBLISHED", "WITHDRAWN"].includes(value as string)) return malformed();
  return value as PublicationAck["state"];
}
function slots(value: unknown): StarSlot[] {
  const raw = object(value, ["items"]);
  if (!Array.isArray(raw.items)) return malformed();
  const result = raw.items.map(value => {
    const row = object(value, ["id", "sceneKey", "story"]);
    if (typeof row.id !== "string" || !slotPattern.test(row.id)
      || typeof row.sceneKey !== "string" || !row.sceneKey.trim() || row.sceneKey.length > 64 || row.sceneKey.includes("\0")) return malformed();
    let story: StarSlot["story"] = null;
    if (row.story !== null) {
      const occupied = object(row.story, ["id", "state"]);
      if (typeof occupied.id !== "string" || !uuid.test(occupied.id)) return malformed();
      story = { id: occupied.id, state: storyState(occupied.state) };
    }
    return { id: row.id, sceneKey: row.sceneKey, story };
  });
  if (new Set(result.map(row => row.id)).size !== result.length
    || new Set(result.map(row => row.sceneKey)).size !== result.length) return malformed();
  return result;
}
function acknowledgement(value: unknown, id: string): PublicationAck {
  const row = object(object(value, ["story"]).story, ["id", "version", "state", "slotId", "hasUnpublishedChanges"]);
  if (row.id !== id || !Number.isSafeInteger(row.version) || (row.version as number) < 0 || (row.version as number) > 2_147_483_647
    || (row.slotId !== null && (typeof row.slotId !== "string" || !slotPattern.test(row.slotId)))
    || typeof row.hasUnpublishedChanges !== "boolean") return malformed();
  return { id, version: row.version as number, state: storyState(row.state),
    slotId: row.slotId as string | null, hasUnpublishedChanges: row.hasUnpublishedChanges };
}
function failure(status: number, write: boolean): PublicationClientError {
  if (status === 401 || status === 403) return new PublicationClientError("denied", status);
  if ([400, 405, 413, 415].includes(status)) return new PublicationClientError("validation", status);
  if (status === 409) return new PublicationClientError("conflict", status);
  if (status === 404 || status === 429) return new PublicationClientError("retryable", status);
  return new PublicationClientError(write ? "uncertain" : "retryable", status);
}

/** Existing P2-10A endpoints only. No write retry or client-side publication proof. */
export function createPublicationApi(fetcher: typeof fetch = globalThis.fetch) {
  async function request<T>(path: string, parse: (value: unknown) => T, options: {
    method?: "PUT" | "POST"; body?: unknown; signal?: AbortSignal;
  } = {}): Promise<T> {
    const write = options.method !== undefined;
    const timeout = AbortSignal.timeout(15_000);
    try {
      const response = await fetcher(path, { method: options.method ?? "GET", credentials: "same-origin", cache: "no-store",
        redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
        headers: { Accept: "application/json", ...(write ? { "Content-Type": "application/json" } : {}) },
        ...(write ? { body: JSON.stringify(options.body) } : {}) });
      if (!response.ok) throw failure(response.status, write);
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) return malformed();
      const body = await response.text();
      if (body.length > 64 * 1024) return malformed();
      return parse(JSON.parse(body));
    } catch (error) {
      if (error instanceof PublicationClientError) throw error;
      if (!write && options.signal?.aborted) throw new PublicationClientError("cancelled");
      throw new PublicationClientError(write ? "uncertain" : "retryable");
    }
  }
  return {
    slots(signal?: AbortSignal): Promise<StarSlot[]> { return request("/api/admin/star-slots", slots, { signal }); },
    async apply(id: string, action: PublicationAction, expectedVersion: number, slotId?: string | null): Promise<PublicationAck> {
      if (!uuid.test(id) || !["slot", "publish", "withdraw", "restore"].includes(action)
        || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= 2_147_483_647
        || (action === "slot" ? slotId !== null && (typeof slotId !== "string" || !slotPattern.test(slotId)) : slotId !== undefined)) {
        throw new PublicationClientError("validation");
      }
      return request(`/api/admin/stories/${id}/${action}`, value => acknowledgement(value, id), {
        method: action === "slot" ? "PUT" : "POST",
        body: { expectedVersion, ...(action === "slot" ? { slotId } : {}) },
      });
    },
  };
}

export const publicationApi = createPublicationApi();
