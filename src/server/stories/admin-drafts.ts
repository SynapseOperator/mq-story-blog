import type { Prisma } from "../../generated/prisma/client.ts";
import { validateStoryContent, validateStoryTitle } from "./content.ts";
import { StoryDomainError, storyIdValue } from "./operations.ts";

export type AdminDraftCursor = { createdAt: string; id: string };
export type AdminStorySummary = {
  id: string; slug: string; kind: "STAR" | "CAMPFIRE"; state: "DRAFT" | "PUBLISHED" | "WITHDRAWN";
  version: number; draftTitle: string; hasUnpublishedChanges: boolean; updatedAt: string;
};
type SummaryRow = { id: string; slug: string; kind: AdminStorySummary["kind"]; state: AdminStorySummary["state"];
  version: number; title: string; hasUnpublishedChanges: boolean; updatedAt: Date; createdAt: Date };
function summary(row: SummaryRow): AdminStorySummary {
  return { id: row.id, slug: row.slug, kind: row.kind, state: row.state, version: row.version,
    draftTitle: validateStoryTitle(row.title), hasUnpublishedChanges: row.hasUnpublishedChanges,
    updatedAt: row.updatedAt.toISOString() };
}

/** Private reads: call inside withAdmin; never cache or accept a revision ID. */
export function createAdminDraftReader(tx: Prisma.TransactionClient) {
  return {
    async get(storyId: string) {
      storyIdValue(storyId);
      const rows = await tx.$queryRaw<(SummaryRow & { content: unknown })[]>`
        SELECT s.id, s.slug, s.kind::text AS kind, s.state::text AS state, s.version, r.title, r.content,
          s.draft_revision_id IS DISTINCT FROM s.published_revision_id AS "hasUnpublishedChanges",
          s.updated_at AS "updatedAt", s.created_at AS "createdAt"
        FROM public.story s JOIN public.story_revision r ON r.story_id=s.id AND r.id=s.draft_revision_id
        WHERE s.id=${storyId}::uuid`;
      if (!rows[0]) throw new StoryDomainError("NOT_FOUND", "故事不存在。");
      return { story: summary(rows[0]), draft: { title: validateStoryTitle(rows[0].title), content: validateStoryContent(rows[0].content) } };
    },
    async list({ limit = 20, cursor }: { limit?: number; cursor?: AdminDraftCursor } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new StoryDomainError("VALIDATION", "分页大小无效。");
      if (cursor) {
        storyIdValue(cursor.id);
        // Cursors originate from immutable, server-timestamped rows. Reject JS
        // expanded years before a value can reach PostgreSQL's timestamp cast.
        if (typeof cursor.createdAt !== "string"
          || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.createdAt)
          || !Number.isFinite(Date.parse(cursor.createdAt))
          || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw new StoryDomainError("VALIDATION", "分页坐标无效。");
      }
      const rows = await tx.$queryRaw<SummaryRow[]>`
        SELECT s.id, s.slug, s.kind::text AS kind, s.state::text AS state, s.version, r.title,
          s.draft_revision_id IS DISTINCT FROM s.published_revision_id AS "hasUnpublishedChanges",
          s.updated_at AS "updatedAt", s.created_at AS "createdAt"
        FROM public.story s JOIN public.story_revision r ON r.story_id=s.id AND r.id=s.draft_revision_id
        WHERE (${cursor?.createdAt ?? null}::timestamptz IS NULL
          OR (s.created_at,s.id) < (${cursor?.createdAt ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
        ORDER BY s.created_at DESC,s.id DESC LIMIT ${limit + 1}`;
      const visible = rows.slice(0, limit), last = visible.at(-1);
      return { items: visible.map(summary), nextCursor: rows.length > limit && last
        ? { createdAt: last.createdAt.toISOString(), id: last.id } : null };
    },
  };
}
