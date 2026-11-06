import { createHash } from "node:crypto";
import type { MediaAsset, Prisma } from "../../generated/prisma/client.ts";
import { withAdmin } from "../admin/access.ts";
import { AdminAccessError } from "../admin/policy.ts";
import { createLocalMediaStore, mediaConfigurationFromEnvironment, type LocalMediaStore } from "./local-store.ts";
import { MEDIA_INPUT_LIMIT, MEDIA_DISPLAY_LIMIT, MediaProcessingError, processMediaImage } from "./processor.ts";
import { beginMediaDeletion, finishMediaDeletion, MediaLifecycleError } from "./lifecycle.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const headers = { "cache-control": "private, no-store, max-age=0", pragma: "no-cache",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin", vary: "Cookie, Origin" };
const maxReservedBytes = MEDIA_DISPLAY_LIMIT + 256 * 1024;

// Subclass preserves the established withAdmin rollback/error boundary. No
// administrator code or private database error needs changing or exposing.
class MediaRequestError extends AdminAccessError {
  readonly mediaCode: string;
  constructor(mediaCode: string, status: number) {
    super("ADMIN_REQUEST_REJECTED", status);
    this.mediaCode = mediaCode;
  }
}
function fail(code: string, status: number): never { throw new MediaRequestError(code, status); }
function configured() {
  if (process.env.MQ_MEDIA_ENABLED !== "true") fail("MEDIA_UNAVAILABLE", 503);
}
function storage() {
  return createLocalMediaStore(mediaConfigurationFromEnvironment(MEDIA_DISPLAY_LIMIT));
}
function assetId(value: string) { if (!uuid.test(value)) fail("INVALID_ASSET_ID", 400); return value; }
function metadata(asset: MediaAsset, publishedStoryCount = 0) {
  return { id: asset.id, state: asset.state, createdAt: asset.createdAt.toISOString(),
    publishedStoryCount,
    display: asset.state === "READY" ? { mimeType: asset.displayMimeType, width: asset.displayWidth,
      height: asset.displayHeight, byteLength: asset.displayBytes, sha256: asset.displaySha256 } : null,
    thumbnail: asset.state === "READY" ? { mimeType: asset.thumbnailMimeType, width: asset.thumbnailWidth,
      height: asset.thumbnailHeight, byteLength: asset.thumbnailBytes, sha256: asset.thumbnailSha256 } : null };
}

/** A live aggregate, not an isPublic flag or an authorization decision. Batch
 * the bounded page in one query; private story identities never enter the DTO. */
async function metadataWithUsage(tx: Prisma.TransactionClient, assets: MediaAsset[]) {
  if (!assets.length) return [];
  const ids = assets.map(asset => asset.id);
  const counts = await tx.$queryRaw<{ assetId: string; count: number }[]>`
    SELECT binding.asset_id AS "assetId", count(DISTINCT story.id)::int AS count
    FROM public.story_revision_asset binding
    JOIN public.story_revision revision ON revision.id = binding.revision_id
    JOIN public.story story ON story.id = revision.story_id AND story.published_revision_id = revision.id
    WHERE story.state = 'PUBLISHED'::public."StoryState" AND binding.asset_id = ANY(${ids}::uuid[])
    GROUP BY binding.asset_id`;
  const byId = new Map(counts.map(row => [row.assetId, row.count]));
  return assets.map(asset => metadata(asset, byId.get(asset.id) ?? 0));
}
function failure(request: Request, error: unknown) {
  const status = error instanceof AdminAccessError || error instanceof MediaProcessingError ? error.status : 503;
  const code = error instanceof MediaRequestError || error instanceof MediaLifecycleError ? error.mediaCode
    : error instanceof AdminAccessError || error instanceof MediaProcessingError ? error.code : "MEDIA_UNAVAILABLE";
  if (status >= 500) console.error("MQ_MEDIA_UNAVAILABLE");
  const reply = { ...headers, ...(status === 429 || status === 503 ? { "retry-after": "30" } : {}) };
  return request.method === "HEAD" ? new Response(null, { status, headers: reply })
    : Response.json({ code }, { status, headers: reply });
}

/** Database clock is authoritative; expires old reservations, not stored READY
 * images. Failure cleanup never holds an administrator authorization lock. */
async function expire(tx: Prisma.TransactionClient) {
  return tx.$queryRaw<{ storage_key: string }[]>`UPDATE public.media_asset SET state='FAILED'
    WHERE state='PENDING' AND created_at <= clock_timestamp() - interval '120 seconds'
    RETURNING storage_key`;
}
async function cleanup(store: LocalMediaStore, keys: string[]) {
  for (const key of keys) {
    try { await store.removeFailed(key); }
    catch { console.error("MQ_MEDIA_RECOVERY_PENDING"); }
  }
}

async function readInput(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) fail("EMPTY_IMAGE", 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new MediaRequestError("UPLOAD_INTERRUPTED", 408));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MEDIA_INPUT_LIMIT) fail("INPUT_TOO_LARGE", 413);
      chunks.push(chunk.value);
    }
    if (!size) fail("EMPTY_IMAGE", 400);
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Transaction-level recovery operation, called only inside withAdmin in HTTP.
 * Kept testable against two real PostgreSQL transactions: a lost finalize ACK
 * can race recovery, and only the winning row transition permits file cleanup. */
export async function settleUploadFailure(tx: Prisma.TransactionClient, id: string) {
  const changed = await tx.$executeRaw`UPDATE public.media_asset SET state='FAILED' WHERE id=${id}::uuid AND state='PENDING'`;
  if (changed === 1) return { failed: true, asset: null };
  const current = await tx.mediaAsset.findUniqueOrThrow({ where: { id } });
  return { failed: current.state === "FAILED", asset: current.state === "READY" ? (await metadataWithUsage(tx, [current]))[0] : null };
}

export async function uploadMedia(request: Request) {
  let reserved: MediaAsset | undefined;
  let store: LocalMediaStore | undefined;
  try {
    const reservation = await withAdmin(request, async tx => {
      configured();
      if (new URL(request.url).search) fail("INVALID_UPLOAD_REQUEST", 400);
      const id = assetId(request.headers.get("idempotency-key") ?? "");
      const mime = request.headers.get("content-type");
      if (!["image/jpeg", "image/png", "image/webp"].includes(mime ?? "")
        || request.headers.has("content-encoding")) fail("UNSUPPORTED_IMAGE", 415);
      const length = request.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MEDIA_INPUT_LIMIT)) fail("INPUT_TOO_LARGE", 413);
      // Admin authorization uses shared locks, so it does NOT serialize uploads.
      // A separate transaction-scoped media lock makes global quota admission
      // atomic across application processes; no I/O is inside this transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(5067085, 1)`;
      if (await tx.mediaAsset.findUnique({ where: { id }, select: { id: true } })) fail("UPLOAD_ALREADY_EXISTS", 409);
      const expired = await expire(tx);
      // Count and reservation are covered by the media admission lock above.
      const [quota] = await tx.$queryRaw<{ pending: number; recent: number; total: number; bytes: bigint }[]>`
        SELECT count(*) FILTER (WHERE state='PENDING')::int AS pending,
          count(*) FILTER (WHERE created_at > clock_timestamp()-interval '1 hour')::int AS recent,
          count(*)::int AS total,
          coalesce(sum(CASE WHEN state='READY' THEN display_bytes::bigint+thumbnail_bytes
            WHEN state='PENDING' THEN ${maxReservedBytes} ELSE 0 END),0)::bigint AS bytes
        FROM public.media_asset`;
      if (quota.pending >= 4 || quota.recent >= 30 || quota.total >= 1000
        || quota.bytes + BigInt(maxReservedBytes) > BigInt(256 * 1024 * 1024)) fail("MEDIA_QUOTA_EXCEEDED", 429);
      // INSERT only id: storageKey/state/timestamps are database defaults.
      await tx.$executeRaw`INSERT INTO public.media_asset (id) VALUES (${id}::uuid)`;
      const asset = await tx.mediaAsset.findUniqueOrThrow({ where: { id } });
      return { asset, expired, mime };
    });
    reserved = reservation.asset;
    store = await storage();
    await cleanup(store, reservation.expired.map(row => row.storage_key));
    const input = await readInput(request);
    const image = await processMediaImage(input, { signal: request.signal });
    if (image.inputMimeType !== reservation.mime) fail("IMAGE_TYPE_MISMATCH", 415);
    await store.write(reserved.storageKey, "display", image.display.bytes);
    await store.write(reserved.storageKey, "thumbnail", image.thumbnail.bytes);
    const id = reserved.id;
    const result = await withAdmin(request, async tx => {
      // Also prevents a stale process completing after recovery marked FAILED.
      const rows = await tx.$queryRaw<{ id: string }[]>`UPDATE public.media_asset
        SET state='READY', display_mime_type='image/webp', display_width=${image.display.width},
          display_height=${image.display.height}, display_bytes=${image.display.byteLength}, display_sha256=${image.display.sha256},
          thumbnail_mime_type='image/webp', thumbnail_width=${image.thumbnail.width}, thumbnail_height=${image.thumbnail.height},
          thumbnail_bytes=${image.thumbnail.byteLength}, thumbnail_sha256=${image.thumbnail.sha256}
        WHERE id=${id}::uuid AND state='PENDING' AND created_at > clock_timestamp()-interval '120 seconds' RETURNING id`;
      if (rows.length !== 1) fail("UPLOAD_EXPIRED", 409);
      return metadata(await tx.mediaAsset.findUniqueOrThrow({ where: { id } }));
    });
    return Response.json({ asset: result }, { status: 201, headers });
  } catch (error) {
    if (reserved) {
      const id = reserved.id;
      // A failed response/commit acknowledgement is not proof of rollback. Read
      // the durable state with fresh authorization; never delete a READY object.
      try {
        const outcome = await withAdmin(request, tx => settleUploadFailure(tx, id));
        if (outcome.asset) return Response.json({ asset: outcome.asset }, { status: 200, headers });
        if (outcome.failed && store) await cleanup(store, [reserved.storageKey]);
      } catch { console.error("MQ_MEDIA_RECOVERY_PENDING"); }
      // Revocation / DB outage leaves a private PENDING reservation; an authorized
      // later status/list request can expire it. No maintenance identity fallback.
    }
    return failure(request, error);
  }
}

export async function listMedia(request: Request) {
  try {
    const result = await withAdmin(request, async tx => {
      configured();
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(key => !["limit", "cursor"].includes(key))
        || query.getAll("limit").length > 1 || query.getAll("cursor").length > 1) fail("INVALID_PAGE", 400);
      const value = query.get("limit") ?? "20";
      if (!/^[1-9]\d?$/.test(value) || Number(value) > 50) fail("INVALID_PAGE", 400);
      const limit = Number(value), cursor = query.get("cursor");
      if (cursor) assetId(cursor);
      const expired = await expire(tx);
      const rows = await tx.mediaAsset.findMany({ where: cursor ? { id: { lt: cursor } } : {},
        orderBy: { id: "desc" }, take: limit + 1 });
      const page = rows.slice(0, limit);
      return { items: await metadataWithUsage(tx, page), nextCursor: rows.length > limit ? page.at(-1)!.id : null,
        cleanupKeys: [...new Set([...expired.map(row => row.storage_key), ...page.filter(row => row.state === "FAILED").map(row => row.storageKey)])] };
    });
    if (result.cleanupKeys.length) await cleanup(await storage(), result.cleanupKeys);
    return Response.json({ items: result.items, nextCursor: result.nextCursor }, { headers });
  } catch (error) { return failure(request, error); }
}

export async function getMedia(request: Request, id: string, content = false) {
  try {
    const result = await withAdmin(request, async tx => {
      configured(); assetId(id);
      const query = new URL(request.url).searchParams;
      if ([...query.keys()].some(key => !content || key !== "variant") || query.getAll("variant").length > 1) fail("INVALID_QUERY", 400);
      const variant = query.get("variant") ?? "display";
      if (variant !== "display" && variant !== "thumbnail") fail("INVALID_VARIANT", 400);
      if (!content) await tx.$executeRaw`UPDATE public.media_asset SET state='FAILED'
        WHERE id=${id}::uuid AND state='PENDING' AND created_at <= clock_timestamp()-interval '120 seconds'`;
      const asset = await tx.mediaAsset.findUnique({ where: { id } });
      if (!asset) fail("MEDIA_NOT_FOUND", 404);
      if (content && asset.state !== "READY") fail("MEDIA_NOT_READY", 404);
      return { asset, variant: variant as "display" | "thumbnail",
        metadata: content ? null : (await metadataWithUsage(tx, [asset]))[0] };
    });
    if (!content) {
      if (result.asset.state === "FAILED") await cleanup(await storage(), [result.asset.storageKey]);
      return Response.json({ asset: result.metadata }, { headers });
    }
    const bytes = await (await storage()).read(result.asset.storageKey, result.variant);
    const expected = result.variant === "display" ? result.asset.displaySha256 : result.asset.thumbnailSha256;
    const expectedLength = result.variant === "display" ? result.asset.displayBytes : result.asset.thumbnailBytes;
    if (bytes.byteLength !== expectedLength || createHash("sha256").update(bytes).digest("hex") !== expected) fail("MEDIA_UNAVAILABLE", 503);
    // Filesystem IO is outside authorization transaction. Recheck immediately
    // before producing bytes/HEAD metadata; never return conditional 304 or Range.
    await withAdmin(request, async tx => {
      const asset = await tx.mediaAsset.findUnique({ where: { id }, select: { state: true } });
      if (asset?.state !== "READY") fail("MEDIA_NOT_READY", 404);
    });
    return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), {
      headers: { ...headers, "content-type": "image/webp", "content-length": String(bytes.byteLength),
        "content-disposition": 'inline; filename="mq-image.webp"', "content-security-policy": "default-src 'none'; sandbox" } });
  } catch (error) { return failure(request, error); }
}

export async function deleteMedia(request: Request, id: string) {
  try {
    const asset = await withAdmin(request, async tx => {
      configured(); assetId(id);
      // Next's Node adapter supplies a stream even for an empty DELETE. Reject
      // framed bodies/encodings rather than treating that stream as input data.
      if (new URL(request.url).search || request.headers.has("transfer-encoding")
        || request.headers.has("content-type") || request.headers.has("content-encoding")
        || ![null, "0"].includes(request.headers.get("content-length"))) fail("INVALID_DELETE_REQUEST", 400);
      if (request.headers.get("x-mq-confirm-delete") !== id) fail("DELETE_CONFIRMATION_REQUIRED", 400);
      return beginMediaDeletion(tx, id);
    });
    if (asset.state === "DELETED") return Response.json({ asset: metadata(asset) }, { headers });
    await (await storage()).removeAsset(asset.storageKey);
    const deleted = await withAdmin(request, tx => finishMediaDeletion(tx, id));
    return Response.json({ asset: metadata(deleted) }, { headers });
  } catch (error) { return failure(request, error); }
}
