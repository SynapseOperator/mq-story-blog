/** Browser DTOs only. Storage keys and filesystem paths are never accepted. */
export type MediaVariant = { mimeType: "image/webp"; width: number; height: number; byteLength: number; sha256: string };
export type MediaAsset = {
  id: string; state: "PENDING" | "READY" | "FAILED" | "DELETING" | "DELETED";
  createdAt: string; publishedStoryCount: number;
  display: MediaVariant | null; thumbnail: MediaVariant | null;
};
export type MediaPage = { items: MediaAsset[]; nextCursor: string | null };
type MediaFailure = "denied" | "invalid" | "limit" | "uncertain" | "unavailable" | "not-found";
const messages: Record<MediaFailure, string> = {
  denied: "管理权限已失效。编辑内容仍保留，请重新登录后再操作图片。",
  invalid: "图片无法处理。请选择 3 MiB 以内的 JPEG、PNG 或静态 WebP，最多 2400 万像素。",
  limit: "图片处理繁忙或已达到素材额度，请稍后再试。",
  uncertain: "上传结果尚未确认。请检查这次上传的状态，不要重复发送文件。",
  unavailable: "暂时无法读取素材，请稍后重试。你的编辑内容仍保留。",
  "not-found": "尚未查到这次上传。它仍可能在处理中，请稍后再次检查或核对素材列表。",
};
export class MediaClientError extends Error {
  readonly kind: MediaFailure;
  constructor(kind: MediaFailure) { super(messages[kind]); this.name = "MediaClientError"; this.kind = kind; }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error("Invalid media response");
  }
  return value as Record<string, unknown>;
}
function variant(value: unknown): MediaVariant {
  const row = object(value, ["mimeType", "width", "height", "byteLength", "sha256"]);
  if (row.mimeType !== "image/webp" || !["width", "height", "byteLength"].every(key =>
    Number.isSafeInteger(row[key]) && Number(row[key]) > 0) || Number(row.width) > 1920 || Number(row.height) > 1920
    || Number(row.byteLength) > 4 * 1024 * 1024 || typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) {
    throw new Error("Invalid media variant");
  }
  return row as MediaVariant;
}
export function parseMediaAsset(value: unknown): MediaAsset {
  const row = object(value, ["id", "state", "createdAt", "publishedStoryCount", "display", "thumbnail"]);
  if (typeof row.id !== "string" || !uuid.test(row.id)
    || !["PENDING", "READY", "FAILED", "DELETING", "DELETED"].includes(row.state as string)
    || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
    || !Number.isSafeInteger(row.publishedStoryCount) || Number(row.publishedStoryCount) < 0) throw new Error("Invalid media asset");
  if (row.state !== "READY" && (row.display !== null || row.thumbnail !== null)) throw new Error("Invalid media state");
  return { id: row.id, state: row.state as MediaAsset["state"], createdAt: row.createdAt,
    publishedStoryCount: row.publishedStoryCount as number,
    display: row.state === "READY" ? variant(row.display) : null,
    thumbnail: row.state === "READY" ? variant(row.thumbnail) : null };
}
function httpFailure(status: number, uploading: boolean): MediaClientError {
  if (status === 401 || status === 403) return new MediaClientError("denied");
  if ([400, 413, 415, 422].includes(status)) return new MediaClientError("invalid");
  if (status === 429) return new MediaClientError("limit");
  if (!uploading && status === 404) return new MediaClientError("not-found");
  return new MediaClientError(uploading ? "uncertain" : "unavailable");
}
function assetResponse(value: unknown, id: string): MediaAsset {
  const asset = parseMediaAsset(object(value, ["asset"]).asset);
  if (asset.id !== id) throw new Error("Mismatched media identity");
  return asset;
}
export function createMediaApi(fetcher: typeof fetch = globalThis.fetch) {
  async function request(path: string, signal?: AbortSignal): Promise<unknown> {
    try {
      const response = await fetcher(path, { credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { accept: "application/json" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      if (!response.ok) throw httpFailure(response.status, false);
      if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("Invalid media response");
      const body = await response.text();
      if (body.length > 64 * 1024) throw new Error("Media response too large");
      return JSON.parse(body);
    } catch (error) { throw error instanceof MediaClientError ? error : new MediaClientError("unavailable"); }
  }
  return {
    async list(cursor: string | null = null, signal?: AbortSignal): Promise<MediaPage> {
      try {
        if (cursor !== null && !uuid.test(cursor)) throw new Error("Invalid cursor");
        const row = object(await request(`/api/admin/media?limit=20${cursor ? `&cursor=${cursor}` : ""}`, signal), ["items", "nextCursor"]);
        if (!Array.isArray(row.items) || row.items.length > 20 || (row.nextCursor !== null
          && (typeof row.nextCursor !== "string" || !uuid.test(row.nextCursor)))) throw new Error("Invalid media page");
        const items = row.items.map(parseMediaAsset);
        if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("Duplicate media identity");
        return { items, nextCursor: row.nextCursor as string | null };
      } catch (error) { throw error instanceof MediaClientError ? error : new MediaClientError("unavailable"); }
    },
    async get(id: string, signal?: AbortSignal): Promise<MediaAsset> {
      try {
        if (!uuid.test(id)) throw new Error("Invalid identity");
        return assetResponse(await request(`/api/admin/media/${id}`, signal), id);
      } catch (error) { throw error instanceof MediaClientError ? error : new MediaClientError("unavailable"); }
    },
  };
}
export const mediaApi = createMediaApi();

/** Raw binary upload, exactly one POST. Upload progress measures sent bytes;
 * upload.onload marks processing, not completion. Unknown results require GET. */
export function uploadMediaFile(file: File, id: string, onProgress: (percent: number) => void,
  onProcessing: () => void, createXhr: () => XMLHttpRequest = () => new XMLHttpRequest()): Promise<MediaAsset> {
  if (!uuid.test(id) || file.size < 1 || file.size > 3 * 1024 * 1024
    || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) return Promise.reject(new MediaClientError("invalid"));
  return new Promise((resolve, reject) => {
    const xhr = createXhr();
    xhr.open("POST", "/api/admin/media");
    xhr.timeout = 60_000;
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Idempotency-Key", id);
    xhr.upload.onprogress = event => { if (event.lengthComputable && event.total > 0) onProgress(Math.min(100, Math.round(event.loaded * 100 / event.total))); };
    xhr.upload.onload = onProcessing;
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new MediaClientError("uncertain"));
    xhr.onload = () => {
      try {
        if (xhr.status < 200 || xhr.status >= 300) throw httpFailure(xhr.status, true);
        if (!/^application\/json(?:;|$)/i.test(xhr.getResponseHeader("content-type") ?? "") || xhr.responseText.length > 16 * 1024) throw new Error("Invalid upload response");
        const asset = assetResponse(JSON.parse(xhr.responseText), id);
        if (asset.state !== "READY") throw new Error("Upload incomplete");
        resolve(asset);
      } catch (error) { reject(error instanceof MediaClientError ? error : new MediaClientError("uncertain")); }
    };
    xhr.send(file);
  });
}
