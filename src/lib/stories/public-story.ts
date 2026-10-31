import type { StoryContent } from "../../server/stories/content.ts";
import type { StorySlotId } from "./scene-catalog";

/** Public transport contracts: summaries intentionally contain no article body,
 * version pointers, timestamps, author identity or private editorial metadata.
 */
export type PublicStorySummary = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
} & (
  | { readonly entry: "star"; readonly slotId: StorySlotId }
  | { readonly entry: "campfire" }
);

export type PublicStoryDetail = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly content: StoryContent;
};
