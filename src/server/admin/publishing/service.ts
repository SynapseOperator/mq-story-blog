import { createHash, createHmac } from "node:crypto";
import type { Prisma } from "../../../generated/prisma/client.ts";
import type { AdminPrincipal } from "../access.ts";
import { AdminAccessError } from "../policy.ts";
import type { PublicationWriter, VersionInput } from "../../stories/operations.ts";
import { createLocalMediaStore, mediaConfigurationFromEnvironment } from "../../media/local-store.ts";
import { MEDIA_DISPLAY_LIMIT } from "../../media/processor.ts";
import { PublicationError, type PublishAction } from "./policy.ts";

/** Constructed and called only inside a verified withAdmin callback. The proof
 * never leaves the server; database identity and transaction are read from tx. */
export function publicationWriter(tx: Prisma.TransactionClient, principal: AdminPrincipal, key: Buffer): PublicationWriter {
  return async change => {
    const [identity] = await tx.$queryRaw<{ database: string; actor: string; transaction: string }[]>`
      SELECT current_database() AS database, session_user::text AS actor,
        pg_current_xact_id()::text AS transaction`;
    const payload = JSON.stringify(["mq-publish-v1", identity.database, identity.actor, identity.transaction,
      principal.sessionId, principal.userId, change.action, change.story.id, String(change.story.version),
      change.targetRevisionId ?? "", change.slotId ?? ""]);
    const signature = createHmac("sha256", key).update(payload, "utf8").digest();
    try {
      await tx.$queryRaw`SELECT public.mq_apply_story_publication(${payload}::text, ${signature}::bytea)`;
      return await tx.story.findUniqueOrThrow({ where: { id: change.story.id } });
    } catch (error) {
      // Only inspect the SQLSTATE; never expose query arguments/driver DETAIL.
      const value = error as { meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } };
      const code = value?.meta?.code ?? value?.meta?.driverAdapterError?.cause?.originalCode;
      if (code === "P7101") throw new AdminAccessError("ADMIN_FORBIDDEN", 403);
      if (code === "P7100") throw new PublicationError("PUBLISH_VALIDATION");
      if (code === "P7103" || code === "23505") throw new PublicationError("PUBLISH_CONFLICT");
      if (code === "P7104") throw new PublicationError("PUBLISH_NOT_FOUND");
      if (code === "P7105") throw new PublicationError("PUBLISH_INVALID_STATE");
      if (code === "P7106") throw new PublicationError("PUBLISH_MEDIA_UNAVAILABLE");
      throw new PublicationError("PUBLISH_UNAVAILABLE");
    }
  };
}

/** The immutable revision/reference/metadata snapshot is server-only. No file
 * path or storage key is returned to the browser or signed as caller input. */
export async function publicationSnapshot(tx: Prisma.TransactionClient, input: VersionInput, action: PublishAction) {
  const story = await tx.story.findUnique({ where: { id: input.storyId } });
  if (!story) throw new PublicationError("PUBLISH_NOT_FOUND");
  if (story.version !== input.expectedVersion) throw new PublicationError("PUBLISH_CONFLICT");
  const revisionId = action === "publish" ? story.draftRevisionId : story.publishedRevisionId;
  if (!revisionId || (action === "restore" ? story.state !== "WITHDRAWN" : story.state === "WITHDRAWN")) {
    throw new PublicationError("PUBLISH_INVALID_STATE");
  }
  const revision = await tx.storyRevision.findUnique({ where: { id: revisionId },
    select: { storyId: true, assets: { orderBy: { assetId: "asc" }, select: { asset: true } } } });
  if (!revision || revision.storyId !== story.id) throw new PublicationError("PUBLISH_UNAVAILABLE");
  const assets = revision.assets.map(reference => reference.asset);
  if (assets.some(asset => asset.state !== "READY")) throw new PublicationError("PUBLISH_MEDIA_UNAVAILABLE");
  return { version: story.version, state: story.state, revisionId, assets };
}

export async function verifyPublicationFiles(snapshot: Awaited<ReturnType<typeof publicationSnapshot>>) {
  if (snapshot.assets.length === 0) return;
  try {
    if (process.env.MQ_MEDIA_ENABLED !== "true") throw new Error("MEDIA_DISABLED");
    const store = await createLocalMediaStore(mediaConfigurationFromEnvironment(MEDIA_DISPLAY_LIMIT));
    // Bounded sequential I/O: at most one <=4 MiB variant in memory. No database
    // transaction or admin lock is held while opening/reading/hashing files.
    for (const asset of snapshot.assets) {
      for (const variant of ["display", "thumbnail"] as const) {
        const bytes = await store.read(asset.storageKey, variant);
        if (bytes.byteLength !== asset[`${variant}Bytes`]
          || createHash("sha256").update(bytes).digest("hex") !== asset[`${variant}Sha256`]) {
          throw new Error("MEDIA_INTEGRITY");
        }
      }
    }
  } catch { throw new PublicationError("PUBLISH_MEDIA_UNAVAILABLE"); }
}
