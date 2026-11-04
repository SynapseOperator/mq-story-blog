export type StoryLikeState = { readonly count: number; readonly liked: boolean };

export class StoryLikeError extends Error {
  readonly status: number | null;
  constructor(status: number | null = null) {
    super("STORY_LIKES_REQUEST_FAILED");
    this.status = status;
  }
}

/** Validate the transport once and retain only the public count/current-user contract. */
export function decodeStoryLikes(value: unknown): StoryLikeState {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("count" in value) || typeof value.count !== "number" || !Number.isSafeInteger(value.count) || value.count < 0
    || !("liked" in value) || typeof value.liked !== "boolean") throw new StoryLikeError();
  return { count: value.count, liked: value.liked };
}

export async function requestStoryLikes(storyId: string, method: "GET" | "PUT" | "DELETE", signal: AbortSignal) {
  const response = await fetch(`/api/stories/${encodeURIComponent(storyId)}/likes`, {
    method, credentials: "same-origin", cache: "no-store",
    ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: "{}" }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw new StoryLikeError(response.status);
  return decodeStoryLikes(await response.json());
}
