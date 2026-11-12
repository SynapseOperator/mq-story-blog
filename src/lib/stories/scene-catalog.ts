import type { Story } from "./story";

// Stable database slots share their responsive positions with the admin preview.
export const storySlotClasses = {
  "star-1": "story-position--1",
  "star-2": "story-position--2",
  "star-3": "story-position--3",
  "star-4": "story-position--4",
  "star-5": "story-position--5",
  "star-6": "story-position--6",
  "star-7": "story-position--7",
} as const;

export type StorySlotId = keyof typeof storySlotClasses;

export type SceneBinding =
  | { readonly storyId: string; readonly entry: "star"; readonly slotId: StorySlotId }
  | { readonly storyId: string; readonly entry: "campfire" };

export type SceneStory = Story & (
  | { readonly entry: "star"; readonly slotId: StorySlotId }
  | { readonly entry: "campfire" }
);

/** Join available stories to explicit bindings; missing content leaves a gap.
 * Reject ambiguous configuration instead of silently moving or replacing stories.
 * This is an adapter guard, not the future database's publishing constraints.
 */
export function bindSceneStories(
  stories: readonly Story[],
  bindings: readonly SceneBinding[],
): SceneStory[] {
  const byId = new Map<string, Story>();
  for (const story of stories) {
    if (!story.id.trim()) throw new Error("Story ID must not be empty");
    if (byId.has(story.id)) throw new Error(`Duplicate story ID: ${story.id}`);
    byId.set(story.id, story);
  }

  const boundStories = new Set<string>();
  const occupiedSlots = new Set<StorySlotId>();
  let hasCampfire = false;
  const catalog: SceneStory[] = [];

  for (const binding of bindings) {
    if (!binding.storyId.trim()) throw new Error("Binding story ID must not be empty");
    if (boundStories.has(binding.storyId)) throw new Error(`Duplicate story binding: ${binding.storyId}`);
    boundStories.add(binding.storyId);

    if (binding.entry === "star") {
      if (!Object.hasOwn(storySlotClasses, binding.slotId)) throw new Error(`Unknown star slot: ${binding.slotId}`);
      if (occupiedSlots.has(binding.slotId)) throw new Error(`Duplicate star slot: ${binding.slotId}`);
      occupiedSlots.add(binding.slotId);
    } else if (binding.entry === "campfire") {
      if (hasCampfire) throw new Error("Only one campfire binding is allowed");
      hasCampfire = true;
    } else {
      throw new Error("Unknown scene entry");
    }

    const story = byId.get(binding.storyId);
    if (!story) continue;
    catalog.push(binding.entry === "star"
      ? { ...story, entry: "star", slotId: binding.slotId }
      : { ...story, entry: "campfire" });
  }
  return catalog;
}
