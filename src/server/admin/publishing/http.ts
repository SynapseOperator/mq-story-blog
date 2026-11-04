import { withAdmin } from "../access.ts";
import { AdminAccessError, inspectAdminRequest } from "../policy.ts";
import { authConfiguration } from "../../auth/policy.ts";
import { draftId, readDraftBody, DraftOperationError } from "../drafts/policy.ts";
import { assertDraftDatabasePrivileges } from "../../stories/draft-privileges.ts";
import { createStoryOperations, mapStoryError, StoryDomainError } from "../../stories/operations.ts";
import { PublicationError, publicationInput, publicationKey, type PublishAction } from "./policy.ts";
import { publicationSnapshot, publicationWriter, verifyPublicationFiles } from "./service.ts";

const headers = { "cache-control": "private, no-store, max-age=0", pragma: "no-cache",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", vary: "Cookie" };
function reply(request: Request, body: unknown, status = 200, extra = {}) {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status, headers: { ...headers, "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export async function handlePublication(request: Request, id?: string, action?: PublishAction) {
  try {
    const allowed = !action ? ["GET", "HEAD"] : action === "slot" ? ["PUT"] : ["POST"];
    if (!allowed.includes(request.method)) return reply(request, { code: "METHOD_NOT_ALLOWED" }, 405, { allow: allowed.join(", ") });
    inspectAdminRequest(request, authConfiguration());
    const url = new URL(request.url);
    const path = action ? `/api/admin/stories/${id}/${action}` : "/api/admin/star-slots";
    if (url.pathname !== path || url.search || request.headers.has("x-http-method-override") || request.headers.has("x-method-override")) {
      throw new PublicationError("PUBLISH_VALIDATION");
    }
    if (id) draftId(id);
    const key = publicationKey();
    if (!action) return reply(request, await withAdmin(request, async tx => {
      await assertDraftDatabasePrivileges(tx);
      return { items: await tx.starSlot.findMany({ orderBy: { id: "asc" },
        select: { id: true, sceneKey: true, story: { select: { id: true, state: true } } } }) };
    }));
    const input = { ...publicationInput(await readDraftBody(request), action), storyId: id! };
    const preflight = action === "publish" || action === "restore"
      ? await withAdmin(request, async tx => {
        await assertDraftDatabasePrivileges(tx);
        return publicationSnapshot(tx, input, action);
      }) : null;
    if (preflight) await verifyPublicationFiles(preflight);
    const result = await withAdmin(request, async (tx, principal) => {
      await assertDraftDatabasePrivileges(tx);
      if (preflight) {
        const current = await publicationSnapshot(tx, input, action);
        if (JSON.stringify(current) !== JSON.stringify(preflight)) throw new PublicationError("PUBLISH_CONFLICT");
      }
      try {
        const operations = createStoryOperations(tx, publicationWriter(tx, principal, key));
        const story = action === "slot" ? await operations.reserveSlot(input) : await operations[action](input);
        return { story: { id: story.id, version: story.version, state: story.state, slotId: story.slotId,
          hasUnpublishedChanges: story.draftRevisionId !== story.publishedRevisionId } };
      } catch (error) {
        const mapped = mapStoryError(error);
        if (mapped instanceof StoryDomainError) throw new PublicationError(`PUBLISH_${mapped.code}`);
        throw mapped;
      }
    });
    return reply(request, result);
  } catch (error) {
    if (error instanceof PublicationError) return reply(request, { code: error.publicationCode }, error.status);
    if (error instanceof DraftOperationError) return reply(request, { code: "PUBLISH_VALIDATION" }, error.status);
    if (error instanceof AdminAccessError) return reply(request, { code: error.code }, error.status);
    console.error("MQ_PUBLICATION_UNAVAILABLE");
    return reply(request, { code: "PUBLISH_UNAVAILABLE" }, 503);
  }
}
