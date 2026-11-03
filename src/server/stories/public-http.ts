import { createDatabaseClient } from "../../lib/db/client.ts";
import { createPublicStoryReader, isPublicStoryId, isPublicStorySlug } from "./public-service.ts";

const headers = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

// Connection singleton only, never a response/publication/session cache. Building
// the application does not initialize a database or require database credentials.
let database: ReturnType<typeof createDatabaseClient> | undefined;
function reader() {
  if (!process.env.DATABASE_URL) throw new Error("PUBLIC_STORIES_UNAVAILABLE");
  database ??= createDatabaseClient(process.env.DATABASE_URL);
  return createPublicStoryReader(database);
}

function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}

export function rejectPublicStoryMethod() {
  return Response.json({ code: "METHOD_NOT_ALLOWED" }, {
    status: 405, headers: { ...headers, allow: "GET, HEAD" },
  });
}

export async function handlePublicStories(request: Request, id?: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return rejectPublicStoryMethod();
  if (new URL(request.url).search) return reply({ code: "PUBLIC_STORY_REQUEST_REJECTED" }, 400);
  if (id !== undefined && !isPublicStoryId(id)) return reply({ code: "PUBLIC_STORY_NOT_FOUND" }, 404);
  try {
    if (id === undefined) return reply({ stories: await reader().listStories() });
    const story = await reader().getStory(id);
    return story ? reply({ story }) : reply({ code: "PUBLIC_STORY_NOT_FOUND" }, 404);
  } catch {
    // Never serialize driver/configuration errors or query values. Empty catalog
    // and unavailable database have distinct responses; no fixture fallback.
    console.error("MQ_PUBLIC_STORIES_UNAVAILABLE");
    return reply({ code: "PUBLIC_STORIES_UNAVAILABLE" }, 503);
  }
}

export async function handlePublicStoryBySlug(request: Request, slug: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return rejectPublicStoryMethod();
  if (new URL(request.url).search) return reply({ code: "PUBLIC_STORY_REQUEST_REJECTED" }, 400);
  if (!isPublicStorySlug(slug)) return reply({ code: "PUBLIC_STORY_NOT_FOUND" }, 404);
  try {
    const story = await reader().getStoryBySlug(slug);
    return story ? reply({ story }) : reply({ code: "PUBLIC_STORY_NOT_FOUND" }, 404);
  } catch {
    console.error("MQ_PUBLIC_STORIES_UNAVAILABLE");
    return reply({ code: "PUBLIC_STORIES_UNAVAILABLE" }, 503);
  }
}

/** Dynamic page metadata uses the same public query boundary as the API.
 * Missing/private/error cases deliberately expose only a generic page title;
 * the client separately obtains the actionable 404/503 reading state. */
export async function readPublicStorySummaryBySlug(slug: string) {
  if (!isPublicStorySlug(slug)) return null;
  try {
    return await reader().getSummaryBySlug(slug);
  } catch {
    console.error("MQ_PUBLIC_STORIES_UNAVAILABLE");
    return null;
  }
}
