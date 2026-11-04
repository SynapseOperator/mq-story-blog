import type { Prisma } from "../../generated/prisma/client.ts";
import { AdminAccessError } from "../admin/policy.ts";

export class MediaLifecycleError extends AdminAccessError {
  readonly mediaCode: string;
  constructor(mediaCode: string, status: number) {
    super("ADMIN_REQUEST_REJECTED", status);
    this.mediaCode = mediaCode;
  }
}

/** Called inside withAdmin, or by the explicitly offline maintenance command.
 * The row lock and native (id,state) foreign key serialize new references with
 * deletion. No filesystem work belongs in this transaction. */
export async function beginMediaDeletion(tx: Prisma.TransactionClient, id: string,
  { offline = false }: { offline?: boolean } = {}) {
  const rows = await tx.$queryRaw<{ expired: boolean }[]>`SELECT
    created_at <= clock_timestamp() - interval '120 seconds' AS expired
    FROM public.media_asset WHERE id=${id}::uuid FOR UPDATE`;
  const asset = await tx.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw new MediaLifecycleError("MEDIA_NOT_FOUND", 404);
  if (asset.state === "DELETED") return asset;
  if (offline && asset.state === "READY") throw new MediaLifecycleError("MEDIA_READY_REQUIRES_DELETE", 409);
  if (asset.state === "PENDING" && !rows[0].expired) throw new MediaLifecycleError("MEDIA_UPLOAD_ACTIVE", 409);
  // A failed/expired upload can still have a filesystem write in flight. Only
  // the offline operator, after stopping upload processes, may clean it up.
  if (!offline && asset.displayMimeType === null) throw new MediaLifecycleError("MEDIA_UPLOAD_ACTIVE", 409);
  if (asset.state === "DELETING") return asset;
  if (await tx.storyRevisionAsset.findFirst({ where: { assetId: id }, select: { assetId: true } })) {
    throw new MediaLifecycleError("MEDIA_REFERENCED", 409);
  }
  return tx.mediaAsset.update({ where: { id }, data: { state: "DELETING" } });
}

/** Reauthorization is required by the HTTP caller after external file removal.
 * A crash or revoked session leaves DELETING available for a controlled retry. */
export async function finishMediaDeletion(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM public.media_asset WHERE id=${id}::uuid FOR UPDATE`;
  const asset = await tx.mediaAsset.findUnique({ where: { id } });
  if (!asset) throw new MediaLifecycleError("MEDIA_NOT_FOUND", 404);
  if (asset.state === "DELETED") return asset;
  if (asset.state !== "DELETING") throw new MediaLifecycleError("MEDIA_NOT_DELETING", 409);
  return tx.mediaAsset.update({ where: { id }, data: { state: "DELETED" } });
}
