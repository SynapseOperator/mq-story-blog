import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { PublicStoryDetail, PublicStorySummary } from "../../lib/stories/public-story.ts";
import { storySlotClasses, type StorySlotId } from "../../lib/stories/scene-catalog.ts";
import { validateStoryContent, validateStoryTitle } from "./content.ts";

type PublicRow = {
  id: string;
  slug: string;
  title: string;
  kind: string;
  slotId: string | null;
  sceneKey: string | null;
};

export function isPublicStoryId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

export function isPublicStorySlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 120 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function summary(row: PublicRow): PublicStorySummary {
  if (!isPublicStoryId(row.id) || !isPublicStorySlug(row.slug)) {
    throw new Error("PUBLIC_STORY_INVALID");
  }
  const identity = { id: row.id, slug: row.slug, title: validateStoryTitle(row.title) };
  if (row.kind === "CAMPFIRE" && row.slotId === null && row.sceneKey === null) {
    return { ...identity, entry: "campfire" };
  }
  if (row.kind === "STAR" && row.slotId !== null && Object.hasOwn(storySlotClasses, row.slotId)
    && storySlotClasses[row.slotId as StorySlotId] === row.sceneKey) {
    return { ...identity, entry: "star", slotId: row.slotId as StorySlotId };
  }
  // A new/unmapped slot needs an explicitly reviewed scene mapping. Never move
  // its content into another star or silently omit a published catalog entry.
  throw new Error("PUBLIC_STORY_SLOT_UNSUPPORTED");
}

function detail(row: (PublicRow & { content: unknown }) | undefined): PublicStoryDetail | null {
  if (!row) return null;
  const visible = summary(row);
  // Explicit reconstruction prevents a future SQL/select extension from
  // exposing revision pointers, drafts or editorial metadata.
  return { id: visible.id, slug: visible.slug, title: visible.title, content: validateStoryContent(row.content) };
}

/** Read-only factory: a caller owns connection lifecycle; this module never
 * caches publication results. Each read is one SQL statement and one PostgreSQL
 * snapshot, including publication state, revision ownership and selected data.
 * A request started after committed withdrawal therefore cannot see that story.
 * No promise is made to retract a response already delivered or in flight.
 */
export function createPublicStoryReader(client: Pick<PrismaClient, "$queryRaw">) {
  return {
    async listStories(): Promise<PublicStorySummary[]> {
      const rows = await client.$queryRaw<PublicRow[]>`
        SELECT s.id, s.slug, s.kind, s.slot_id AS "slotId", slots.scene_key AS "sceneKey", r.title
        FROM public.story s
        JOIN public.story_revision r ON r.story_id = s.id AND r.id = s.published_revision_id
        LEFT JOIN public.star_slot slots ON slots.id = s.slot_id
        WHERE s.state = 'PUBLISHED'::public."StoryState"
        ORDER BY s.slot_id ASC NULLS LAST, s.id ASC`;
      return rows.map(summary);
    },

    async getStory(id: string): Promise<PublicStoryDetail | null> {
      if (!isPublicStoryId(id)) return null;
      const rows = await client.$queryRaw<(PublicRow & { content: unknown })[]>`
        SELECT s.id, s.slug, s.kind, s.slot_id AS "slotId", slots.scene_key AS "sceneKey", r.title, r.content
        FROM public.story s
        JOIN public.story_revision r ON r.story_id = s.id AND r.id = s.published_revision_id
        LEFT JOIN public.star_slot slots ON slots.id = s.slot_id
        WHERE s.id = ${id}::uuid AND s.state = 'PUBLISHED'::public."StoryState"`;
      return detail(rows[0]);
    },

    async getStoryBySlug(slug: string): Promise<PublicStoryDetail | null> {
      if (!isPublicStorySlug(slug)) return null;
      const rows = await client.$queryRaw<(PublicRow & { content: unknown })[]>`
        SELECT s.id, s.slug, s.kind, s.slot_id AS "slotId", slots.scene_key AS "sceneKey", r.title, r.content
        FROM public.story s
        JOIN public.story_revision r ON r.story_id = s.id AND r.id = s.published_revision_id
        LEFT JOIN public.star_slot slots ON slots.id = s.slot_id
        WHERE s.slug = ${slug} AND s.state = 'PUBLISHED'::public."StoryState"`;
      return detail(rows[0]);
    },

    // Metadata needs the public title only. Do not fetch article content and
    // then strip it: both the SELECT and the returned DTO exclude the body.
    async getSummaryBySlug(slug: string): Promise<PublicStorySummary | null> {
      if (!isPublicStorySlug(slug)) return null;
      const rows = await client.$queryRaw<PublicRow[]>`
        SELECT s.id, s.slug, s.kind, s.slot_id AS "slotId", slots.scene_key AS "sceneKey", r.title
        FROM public.story s
        JOIN public.story_revision r ON r.story_id = s.id AND r.id = s.published_revision_id
        LEFT JOIN public.star_slot slots ON slots.id = s.slot_id
        WHERE s.slug = ${slug} AND s.state = 'PUBLISHED'::public."StoryState"`;
      return rows[0] ? summary(rows[0]) : null;
    },
  };
}
