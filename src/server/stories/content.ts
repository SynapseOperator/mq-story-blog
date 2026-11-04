export type ParagraphBlock = {
  type: "paragraph";
  text: string;
  style?: "normal" | "emphasis" | "strong";
};

export type ImageBlock = {
  type: "image";
  src: string;
  alt: string;
  caption?: string;
};

export type AssetImageBlock = {
  type: "image";
  assetId: string;
  alt: string;
  caption?: string;
};

export type StoryContentV1 = {
  version: 1;
  blocks: (ParagraphBlock | ImageBlock)[];
};
export type StoryContentV2 = {
  version: 2;
  blocks: (ParagraphBlock | AssetImageBlock)[];
};
export type StoryContent = StoryContentV1 | StoryContentV2;

export class ContentValidationError extends Error {
  readonly code = "VALIDATION";

  constructor(message: string) {
    super(message);
    this.name = "ContentValidationError";
  }
}

// Existing synthetic scene image, reused as a read-only prototype reference.
// Legacy draft writes retain this explicit allowlist. New managed images use
// assetId in v2; existing revisions are never rewritten or silently imported.
export const SYNTHETIC_STORY_IMAGES: readonly string[] = ["/scene/night-sky.webp"];

function reject(message: string): never {
  throw new ContentValidationError(message);
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return reject("内容块必须是普通 JSON 对象。");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) {
    return reject("内容包含未支持的字段。");
  }
  return record;
}

function text(value: unknown, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    value.includes("\0")
  ) {
    return reject(`${label}必须为非空文本，且不超过 ${max} 个字符。`);
  }
  return value;
}

export function validateStoryTitle(value: unknown): string {
  return text(value, 160, "标题").trim();
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function imageSource(value: unknown): string {
  const src = text(value, 2048, "图片地址");
  if (SYNTHETIC_STORY_IMAGES.includes(src)) return src;
  if (src !== src.trim() || containsControl(src) || src.includes("\\")) {
    return reject("图片地址包含不安全字符。");
  }
  if (src.startsWith("/story-media/")) {
    // Local assets stay within the dedicated media directory. Do not allow an
    // encoded slash or traversal to escape it after browser/server decoding.
    let decoded: string;
    try {
      decoded = decodeURIComponent(src);
    } catch {
      return reject("图片地址编码无效。");
    }
    if (
      /[%?#\\]/u.test(decoded) ||
      containsControl(decoded) ||
      /%2f|%5c/iu.test(src) ||
      decoded.split("/").some((part) => part === "." || part === "..") ||
      decoded.slice("/story-media/".length).length === 0
    ) {
      return reject("本地图片必须位于 /story-media/ 目录内。");
    }
    return src;
  }
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return reject("图片地址必须是 HTTPS 或 /story-media/ 下的本地路径。");
  }
  if (
    !src.startsWith("https://") ||
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    return reject("远程图片仅支持不含凭据的 HTTPS 地址。");
  }
  return src;
}

// The returned value is a fresh, bounded JSON document. Text remains plain
// text, not trusted HTML; a future renderer must use escaped DOM text nodes.
export function validateStoryContent(value: unknown): StoryContent {
  const input = object(value, ["version", "blocks"]);
  if (
    (input.version !== 1 && input.version !== 2) ||
    !Array.isArray(input.blocks) ||
    input.blocks.length < 1 ||
    input.blocks.length > 200 ||
    Array.from(input.blocks).some((block) => block === undefined)
  ) {
    return reject("正文必须使用版本 1 或 2，包含 1 至 200 个内容块。");
  }
  const blocks = input.blocks.map((raw): ParagraphBlock | ImageBlock | AssetImageBlock => {
    const block = object(raw, ["type", "text", "style", "src", "assetId", "alt", "caption"]);
    if (block.type === "paragraph") {
      object(block, ["type", "text", "style"]);
      const result: ParagraphBlock = {
        type: "paragraph",
        text: text(block.text, 10_000, "段落"),
      };
      if ("style" in block) {
        if (!["normal", "emphasis", "strong"].includes(block.style as string)) {
          return reject("段落仅支持 normal、emphasis 或 strong 格式。");
        }
        result.style = block.style as ParagraphBlock["style"];
      }
      return result;
    }
    if (block.type === "image") {
      object(block, input.version === 1 ? ["type", "src", "alt", "caption"] : ["type", "assetId", "alt", "caption"]);
      if (input.version === 2 && (typeof block.assetId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(block.assetId))) {
        return reject("版本 2 图片必须引用有效素材 ID。");
      }
      const result: ImageBlock | AssetImageBlock = input.version === 1 ? {
        type: "image",
        src: imageSource(block.src),
        alt: text(block.alt, 300, "图片替代文本"),
      } : {
        type: "image",
        assetId: (block.assetId as string).toLowerCase(),
        alt: text(block.alt, 300, "图片替代文本"),
      };
      if ("caption" in block) result.caption = text(block.caption, 1000, "图片说明");
      return result;
    }
    return reject("正文仅支持段落与图片，不支持 HTML 或其他内容块。");
  });
  // The version branch above rejects mixed src/assetId blocks before creating
  // this discriminated document. Keep the v1 limit unchanged for old content.
  const content: StoryContent = input.version === 1
    ? { version: 1, blocks: blocks as StoryContentV1["blocks"] }
    : { version: 2, blocks: blocks as StoryContentV2["blocks"] };
  let byteLength = new TextEncoder().encode(JSON.stringify(content)).byteLength;
  if (content.version === 2) {
    // PostgreSQL jsonb::text adds one ASCII space after each structural colon
    // and comma. This fixed, flat block contract lets us count them without
    // touching commas/colons inside user strings or depending on key ordering.
    byteLength += 3 + blocks.length - 1 + blocks.reduce((sum, block) => sum + 2 * Object.keys(block).length - 1, 0);
    if (blocks.some(block => Object.values(block).some(value => typeof value === "string" && !value.isWellFormed()))) {
      return reject("正文包含无效 Unicode 文本。");
    }
  }
  if (byteLength > 256 * 1024) {
    return reject("正文大小不得超过 256 KiB。");
  }
  return content;
}
