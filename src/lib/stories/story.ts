import type { PublicStoryDetail } from "./public-story";

/** Legacy synthetic fixtures remain usable in explicitly isolated tests. They
 * are never a fallback for the public PostgreSQL source. */
export interface DemoStory {
  readonly id: string;
  readonly title: string;
  readonly source: "synthetic-demo";
  readonly date: string;
  readonly introduction: string;
  readonly paragraphs: readonly string[];
  readonly image: {
    readonly src: string;
    readonly alt: string;
    readonly caption: string;
  };
  readonly closing: string;
}

/** Published revisions have no invented date, introduction, author or closing. */
export type Story = DemoStory | (PublicStoryDetail & { readonly source: "published" });

export type LetterContentState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly unavailable: boolean }
  | { readonly status: "ready"; readonly story: Story };
