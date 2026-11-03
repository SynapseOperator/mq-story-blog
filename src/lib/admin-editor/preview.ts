import type { LetterPreviewSnapshot } from "../stories/story.ts";
import type { EditorDocument } from "./types.ts";

/** Preview the current working document, even before it is valid to save.
 * Keep entered whitespace and optional fields; saving has separate normalization.
 * Explicit field selection excludes editor keys and persistence identities. */
export function createPreviewSnapshot(document: EditorDocument, hasUnsavedChanges: boolean): LetterPreviewSnapshot {
  const blocks = document.blocks.map(block => Object.freeze(block.type === "paragraph"
    ? { type: "paragraph" as const, text: block.text,
      ...(block.style !== undefined ? { style: block.style } : {}) }
    : { type: "image" as const, src: block.src, alt: block.alt,
      ...(block.caption !== undefined ? { caption: block.caption } : {}) }));
  return Object.freeze({
    title: document.title,
    content: Object.freeze({ version: 1 as const, blocks: Object.freeze(blocks) }),
    hasUnsavedChanges,
  });
}
