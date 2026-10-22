import type { SceneBinding } from "../lib/stories/scene-catalog";

// Explicit identities, independent of the order or availability of story data.
export const demoBindings = [
  { storyId: "demo-starlight", entry: "star", slotId: "star-1" },
  { storyId: "demo-evening", entry: "star", slotId: "star-2" },
  { storyId: "demo-everyday", entry: "star", slotId: "star-3" },
  { storyId: "demo-campfire", entry: "campfire" },
] as const satisfies readonly SceneBinding[];
