// Browser-only draft contract. Do not import server configuration, Prisma,
// authentication internals or private database models into the editor bundle.
export type StoryKind = "STAR" | "CAMPFIRE";
export type ParagraphStyle = "normal" | "emphasis" | "strong";
export type Paragraph = { type: "paragraph"; text: string; style?: ParagraphStyle };
export type DraftImage = { type: "image"; src: string; alt: string; caption?: string };
export type AssetImage = { type: "image"; assetId: string; alt: string; caption?: string };
export type DraftBlock = Paragraph | DraftImage | AssetImage;
export type DraftContent = { version: 1; blocks: (Paragraph | DraftImage)[] }
  | { version: 2; blocks: (Paragraph | AssetImage)[] };
export type DraftRevision = { title: string; content: DraftContent };
export type DraftSummary = {
  id: string;
  slug: string;
  kind: StoryKind;
  state: "DRAFT" | "PUBLISHED" | "WITHDRAWN";
  version: number;
  draftTitle: string;
  hasUnpublishedChanges: boolean;
  updatedAt: string;
};
export type DraftDetail = { story: DraftSummary; draft: DraftRevision };
export type DraftList = { items: DraftSummary[]; nextCursor: string | null };
export type EditorBlock = DraftBlock & { key: string };
// The editor can temporarily contain both image kinds while the administrator
// explicitly replaces legacy pictures. Mixed content is never saveable.
export type EditorDocument = { kind: StoryKind; title: string; contentVersion?: 1 | 2; blocks: EditorBlock[] };
export type FailureKind = "validation" | "conflict" | "uncertain" | "denied" | "retryable" | "cancelled";

export const EDITOR_SYNTHETIC_IMAGE = "/scene/night-sky.webp";
