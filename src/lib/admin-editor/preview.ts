import type { LetterPreviewSnapshot } from "../stories/story.ts";
import type { EditorDocument } from "./types.ts";

/** Preview the current working document, even before it is valid to save.
 * Keep entered whitespace and optional fields; saving has separate normalization.
 * Explicit field selection excludes editor keys and persistence identities. */
export function createPreviewSnapshot(document: EditorDocument, hasUnsavedChanges: boolean): LetterPreviewSnapshot {
  const blocks = document.blocks.map(block => Object.freeze(block.type === "paragraph"
    ? { type: "paragraph" as const, text: block.text,
      ...(block.style !== undefined ? { style: block.style } : {}) }
    : { type: "image" as const, ...("assetId" in block ? { assetId: block.assetId } : { src: block.src }), alt: block.alt,
      ...(block.caption !== undefined ? { caption: block.caption } : {}) }));
  return Object.freeze({
    title: document.title,
    content: Object.freeze({ version: document.blocks.some(block => block.type === "image" && "assetId" in block)
      ? 2 as const : document.blocks.some(block => block.type === "image" && "src" in block)
        ? 1 as const : document.contentVersion ?? 1, blocks: Object.freeze(blocks) }),
    hasUnsavedChanges,
  });
}
