import { randomUUID } from "node:crypto";
import { withAdmin } from "../access.ts";
import { AdminAccessError, inspectAdminRequest } from "../policy.ts";
import { authConfiguration } from "../../auth/policy.ts";
import { createStoryOperations, mapStoryError } from "../../stories/operations.ts";
import { StoryDomainError } from "../../stories/service.ts";
import { createAdminDraftReader } from "../../stories/admin-drafts.ts";
import { assertDraftDatabasePrivileges } from "../../stories/draft-privileges.ts";
import { draftCreate, draftSave, draftPage, draftId, encodeDraftCursor, readDraftBody, DraftOperationError } from "./policy.ts";

const privateHeaders = {
  "cache-control": "private, no-store, max-age=0", pragma: "no-cache",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "vary": "Cookie",
};
function reply(request: Request, body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status, headers: { ...privateHeaders, "content-type": "application/json; charset=utf-8", ...extra },
  });
}

/** Four private APIs only. Public queries, rendering and metadata never import
 * this adapter; no write is made outside the existing authorization transaction. */
export async function handleAdminDrafts(request: Request, id?: string) {
  try {
    const allowed = id === undefined ? ["GET", "HEAD", "POST"] : ["GET", "HEAD", "PUT"];
    if (!allowed.includes(request.method)) return reply(request, { code: "DRAFT_METHOD_NOT_ALLOWED" }, 405, { allow: allowed.join(", ") });
    const config = authConfiguration();
    inspectAdminRequest(request, config);
    const url = new URL(request.url);
    const path = id === undefined ? "/api/admin/stories" : `/api/admin/stories/${id}/draft`;
    if (url.pathname !== path || request.headers.has("x-http-method-override") || request.headers.has("x-method-override")) {
      throw new DraftOperationError("DRAFT_VALIDATION");
    }
    if (id !== undefined) draftId(id);
    const reading = request.method === "GET" || request.method === "HEAD";
    if ((id !== undefined || !reading) && url.search) throw new DraftOperationError("DRAFT_VALIDATION");
    const page = id === undefined && reading ? draftPage(url.searchParams) : null;
    const create = request.method === "POST" ? draftCreate(await readDraftBody(request)) : null;
    const save = request.method === "PUT" ? draftSave(await readDraftBody(request)) : null;
    const data = await withAdmin(request, async tx => {
      await assertDraftDatabasePrivileges(tx);
      try {
        const reader = createAdminDraftReader(tx);
        const operations = createStoryOperations(tx);
        if (page) {
          const result = await reader.list(page);
          return { items: result.items, nextCursor: encodeDraftCursor(result.nextCursor) };
        }
        let selected = id;
        if (create) {
          const story = await operations.createDraft({ ...create, slug: `story-${randomUUID().replaceAll("-", "")}`, slotId: null });
          selected = story.id;
        } else if (save && id) {
          await operations.saveDraft({ ...save, storyId: id });
        }
        const detail = await reader.get(selected!);
        if (!detail) throw new StoryDomainError("NOT_FOUND", "Story not found");
        return reading ? detail : { story: detail.story };
      } catch (error) {
        const mapped = mapStoryError(error);
        if (mapped instanceof StoryDomainError) {
          // Throw THROUGH withAdmin: its transaction rolls back before this
          // trusted AdminAccessError subtype reaches the HTTP catch below.
          throw new DraftOperationError(`DRAFT_${mapped.code}`);
        }
        throw mapped;
      }
    });
    return reply(request, data, create ? 201 : 200,
      create && data.story ? { location: `/api/admin/stories/${data.story.id}/draft` } : {});
  } catch (error) {
    if (error instanceof DraftOperationError) return reply(request, { code: error.draftCode }, error.status);
    if (error instanceof AdminAccessError) return reply(request, { code: error.code }, error.status);
    console.error("MQ_ADMIN_DRAFT_UNAVAILABLE");
    return reply(request, { code: "ADMIN_UNAVAILABLE" }, 503);
  }
}
