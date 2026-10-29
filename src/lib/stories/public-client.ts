import { validateStoryContent, validateStoryTitle } from "../../server/stories/content.ts";
import { storySlotClasses } from "./scene-catalog.ts";
import type { PublicStoryDetail, PublicStorySummary } from "./public-story.ts";

export class PublicStoryReadError extends Error {
  readonly unavailable: boolean;
  constructor(unavailable = false) {
    super("PUBLIC_STORY_READ_FAILED");
    this.unavailable = unavailable;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicStoryReadError();
  return value as Record<string, unknown>;
}

function identity(value: unknown) {
  const item = object(value);
  if (typeof item.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.id)
    || typeof item.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug) || item.slug.length > 120) {
    throw new PublicStoryReadError();
  }
  return { id: item.id, slug: item.slug, title: validateStoryTitle(item.title) };
}

/** Decode only the public contract. Invalid/ambiguous entries never become
 * clickable stars. The content validator is pure code; no DB module is imported. */
export function decodePublicCatalog(value: unknown): PublicStorySummary[] {
  const data = object(value);
  if (!Array.isArray(data.stories)) throw new PublicStoryReadError();
  const identities = new Set<string>();
  const entries = new Set<string>();
  return data.stories.map((raw) => {
    const item = object(raw);
    const base = identity(item);
    const entry = item.entry === "campfire" ? "campfire" : item.entry === "star"
      && typeof item.slotId === "string" && Object.hasOwn(storySlotClasses, item.slotId) ? item.slotId : null;
    if (!entry || identities.has(base.id) || entries.has(entry)) throw new PublicStoryReadError();
    identities.add(base.id);
    entries.add(entry);
    return entry === "campfire" ? { ...base, entry: "campfire" }
      : { ...base, entry: "star", slotId: entry as keyof typeof storySlotClasses };
  });
}

export function decodePublicStory(value: unknown, expectedId: string): PublicStoryDetail {
  const item = object(object(value).story);
  const base = identity(item);
  if (base.id !== expectedId) throw new PublicStoryReadError();
  return { ...base, content: validateStoryContent(item.content) };
}

async function read(path: string, signal: AbortSignal) {
  const response = await fetch(path, { cache: "no-store", credentials: "omit",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!response.ok) throw new PublicStoryReadError(response.status === 404);
  return response.json() as Promise<unknown>;
}

export async function readPublicCatalog(signal: AbortSignal) {
  return decodePublicCatalog(await read("/api/stories", signal));
}

export async function readPublicStory(id: string, signal: AbortSignal) {
  return decodePublicStory(await read(`/api/stories/${encodeURIComponent(id)}`, signal), id);
}

export async function readPublicStoryBySlug(slug: string, signal: AbortSignal) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120) throw new PublicStoryReadError(true);
  const value = await read(`/api/stories/by-slug/${encodeURIComponent(slug)}`, signal);
  const record = object(object(value).story);
  const base = identity(record);
  if (base.slug !== slug) throw new PublicStoryReadError();
  return { ...base, content: validateStoryContent(record.content) };
}
