/** Synthetic fixtures for entry testing only; these are not published articles. */
export const demoStories = [
  { id: "demo-starlight", title: "一起数星星", entry: "star", source: "synthetic-demo" },
  { id: "demo-evening", title: "山坡上的晚风", entry: "star", source: "synthetic-demo" },
  { id: "demo-everyday", title: "把日常写成诗", entry: "star", source: "synthetic-demo" },
  { id: "demo-campfire", title: "我们在一起的故事", entry: "campfire", source: "synthetic-demo" },
] as const;

export type DemoStory = (typeof demoStories)[number];
export const starStories = demoStories.filter((story) => story.entry === "star");
export const campfireStory = demoStories[3];
