import { createHash } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.ts";
import { createDatabaseClient } from "../../lib/db/client.ts";
import { isPublicStoryId } from "../stories/public-service.ts";
import { createLocalMediaStore } from "./local-store.ts";
import { MEDIA_DISPLAY_LIMIT } from "./processor.ts";

const headers = {
  "cache-control": "no-store, max-age=0", pragma: "no-cache",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
};

type PublicMedia = { storageKey: string; sha256: string; byteLength: number };

/** One statement/snapshot proves the current publication, revision ownership,
 * immutable projected reference and READY state. The result is server-only:
 * never serialize storage keys or expose a reusable static/signed URL. */
export async function readPublicMedia(client: Pick<PrismaClient, "$queryRaw">, storyId: string, assetId: string) {
  const rows = await client.$queryRaw<PublicMedia[]>`
    SELECT asset.storage_key AS "storageKey", asset.display_sha256 AS sha256,
      asset.display_bytes AS "byteLength"
    FROM public.story story
    JOIN public.story_revision revision
      ON revision.story_id = story.id AND revision.id = story.published_revision_id
    JOIN public.story_revision_asset reference ON reference.revision_id = revision.id
    JOIN public.media_asset asset ON asset.id = reference.asset_id AND asset.state = reference.required_state
    WHERE story.id = ${storyId}::uuid AND story.state = 'PUBLISHED'::public."StoryState"
      AND asset.id = ${assetId}::uuid AND asset.state = 'READY'::public."MediaAssetState"`;
  return rows[0] ?? null;
}

// Connection pooling only: no publication, byte, permission or response cache.
let database: ReturnType<typeof createDatabaseClient> | undefined;
function client() {
  if (!process.env.DATABASE_URL || process.env.MQ_MEDIA_ENABLED !== "true") throw new Error("PUBLIC_MEDIA_UNAVAILABLE");
  database ??= createDatabaseClient(process.env.DATABASE_URL);
  return database;
}
function failure(request: Request, code: string, status: number, extra: Record<string, string> = {}) {
  return new Response(request.method === "HEAD" ? null : JSON.stringify({ code }), {
    status, headers: { ...headers, "content-type": "application/json; charset=utf-8", ...extra },
  });
}
export function rejectPublicMediaMethod(request: Request) {
  return failure(request, "METHOD_NOT_ALLOWED", 405, { allow: "GET, HEAD" });
}

/** Only the processed display variant is public. HEAD and conditional/range
 * requests execute the full same checks; none can return 304/206 or redirect to
 * storage. Already-delivered/in-flight bytes cannot be remotely recalled. */
export async function handlePublicMedia(request: Request, storyId: string, assetId: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return rejectPublicMediaMethod(request);
  if (new URL(request.url).search || request.headers.has("x-http-method-override") || request.headers.has("x-method-override")) {
    return failure(request, "PUBLIC_MEDIA_REQUEST_REJECTED", 400);
  }
  if (!isPublicStoryId(storyId) || !isPublicStoryId(assetId)) return failure(request, "PUBLIC_MEDIA_NOT_FOUND", 404);
  try {
    const db = client();
    const media = await readPublicMedia(db, storyId, assetId);
    if (!media) return failure(request, "PUBLIC_MEDIA_NOT_FOUND", 404);
    // No database transaction or authorization lock remains open during I/O.
    const store = await createLocalMediaStore({ projectRoot: process.cwd(),
      roots: { development: process.env.MQ_MEDIA_DEVELOPMENT_ROOT ?? "", test: process.env.MQ_MEDIA_TEST_ROOT ?? "" },
      environment: process.env.MQ_MEDIA_ENV as "development" | "test", maxVariantBytes: MEDIA_DISPLAY_LIMIT });
    const bytes = await store.read(media.storageKey, "display");
    if (bytes.byteLength !== media.byteLength || createHash("sha256").update(bytes).digest("hex") !== media.sha256) {
      throw new Error("PUBLIC_MEDIA_UNAVAILABLE");
    }
    // A withdrawal or published-revision replacement committed during file I/O
    // must deny these bytes too. Immutable asset metadata needs no cache token.
    if (!await readPublicMedia(db, storyId, assetId)) return failure(request, "PUBLIC_MEDIA_NOT_FOUND", 404);
    return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), {
      headers: { ...headers, "content-type": "image/webp", "content-length": String(bytes.byteLength),
        "content-disposition": 'inline; filename="mq-image.webp"', "content-security-policy": "default-src 'none'; sandbox" },
    });
  } catch {
    console.error("MQ_PUBLIC_MEDIA_UNAVAILABLE");
    return failure(request, "PUBLIC_MEDIA_UNAVAILABLE", 503);
  }
}
