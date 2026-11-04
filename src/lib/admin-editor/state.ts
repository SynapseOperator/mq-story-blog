import { EDITOR_SYNTHETIC_IMAGE, type DraftDetail, type DraftRevision, type DraftSummary,
  type EditorBlock, type EditorDocument, type FailureKind, type StoryKind } from "./types.ts";

export type SaveAttempt = Readonly<{
  requestId: string;
  instanceId: string;
  storyId: string | null;
  expectedVersion: number | null;
  document: EditorDocument;
}>;
export type EditorState = {
  instanceId: string;
  working: EditorDocument;
  baseline: EditorDocument;
  confirmed: { story: DraftSummary; document: EditorDocument } | null;
  lastSent: SaveAttempt | null;
  pending: SaveAttempt | null;
  status: "ready" | "saving" | "conflict" | "uncertain" | "denied";
  error: string | null;
  remote: DraftDetail | null;
};
export type EditorAction =
  | { type: "edit"; document: EditorDocument }
  | { type: "begin-save"; requestId: string }
  | { type: "save-ok"; requestId: string; story: DraftSummary }
  | { type: "save-error"; requestId: string; kind: FailureKind; message: string }
  | { type: "access-denied"; message?: string }
  | { type: "remote-read"; detail: DraftDetail }
  | { type: "keep-local" }
  | { type: "use-remote" };

function copy(document: EditorDocument): EditorDocument {
  return { kind: document.kind, title: document.title, blocks: document.blocks.map(block => ({ ...block })) };
}

/** This is the exact payload normalization used by the HTTP client. Empty
 * optional captions are omitted; title whitespace follows the server's trim. */
export function toRevision(document: EditorDocument): DraftRevision {
  return { title: document.title.trim(), content: { version: 1, blocks: document.blocks.map(block =>
    block.type === "paragraph"
      ? { type: "paragraph" as const, text: block.text, style: block.style ?? "normal" }
      : { type: "image" as const, src: block.src, alt: block.alt,
        ...(block.caption?.trim() ? { caption: block.caption } : {}) }) } };
}

function same(left: EditorDocument, right: EditorDocument): boolean {
  return left.kind === right.kind && JSON.stringify(toRevision(left)) === JSON.stringify(toRevision(right));
}

function fromDetail(detail: DraftDetail, instanceId: string): EditorDocument {
  return { kind: detail.story.kind, title: detail.draft.title,
    blocks: detail.draft.content.blocks.map((block, index) => ({ ...block, key: `${instanceId}-block-${index}` })) };
}

/** instanceId is generated at a client event/mount, never during SSR rendering. */
export function createEditor(kind: StoryKind, instanceId = globalThis.crypto.randomUUID()): EditorState {
  const working: EditorDocument = { kind, title: "", blocks: [{ key: `${instanceId}-block-0`, type: "paragraph", text: "", style: "normal" }] };
  return { instanceId, working, baseline: copy(working), confirmed: null,
    lastSent: null, pending: null, status: "ready", error: null, remote: null };
}

export function openEditor(detail: DraftDetail, instanceId = globalThis.crypto.randomUUID()): EditorState {
  const working = fromDetail(detail, instanceId);
  return { instanceId, working, baseline: copy(working),
    confirmed: { story: { ...detail.story }, document: copy(working) },
    lastSent: null, pending: null, status: "ready", error: null, remote: null };
}

export function isDirty(state: EditorState): boolean {
  return !same(state.working, state.confirmed?.document ?? state.baseline);
}

export function needsLeaveProtection(state: EditorState): boolean {
  return isDirty(state) || state.pending !== null || state.status === "uncertain" || state.status === "conflict";
}

export function validateDocument(document: EditorDocument): string | null {
  if (!["STAR", "CAMPFIRE"].includes(document.kind)) return "请选择故事类型。";
  if (!document.title.trim() || document.title.length > 160 || document.title.includes("\0")) return "标题不能为空，且最多 160 个字符。";
  if (document.blocks.length < 1 || document.blocks.length > 200) return "正文需要 1 至 200 个内容块。";
  const keys = new Set<string>();
  for (const block of document.blocks) {
    if (!block.key || keys.has(block.key)) return "内容块标识异常，请保留文本并重新读取草稿。";
    keys.add(block.key);
    if (block.type === "paragraph") {
      if (!block.text.trim() || block.text.length > 10000 || block.text.includes("\0")) return "每段文字不能为空，且最多 10000 个字符。";
      if (block.style !== undefined && !["normal", "emphasis", "strong"].includes(block.style)) return "段落样式暂不支持。";
    } else if (block.type === "image") {
      if (block.src !== EDITOR_SYNTHETIC_IMAGE) return "当前只支持已有的合成星空图片。";
      if (!block.alt.trim() || block.alt.length > 300 || block.alt.includes("\0")) return "请填写图片说明，最多 300 个字符。";
      if ((block.caption?.length ?? 0) > 1000 || block.caption?.includes("\0")) return "图片附注最多 1000 个字符。";
    } else return "正文仅支持段落和图片。";
  }
  if (new TextEncoder().encode(JSON.stringify(toRevision(document).content)).byteLength > 256 * 1024) return "正文过长，请缩短至 256 KiB 以内。";
  return null;
}

export function canSave(state: EditorState): boolean {
  return state.status === "ready" && state.pending === null && (isDirty(state) || state.confirmed === null)
    && validateDocument(state.working) === null;
}

function normalizedSnapshot(document: EditorDocument): EditorDocument {
  const revision = toRevision(document);
  return { kind: document.kind, title: revision.title,
    blocks: revision.content.blocks.map((block, index) => ({ ...block, key: document.blocks[index].key })) };
}

function matchesPending(state: EditorState, requestId: string): state is EditorState & { pending: SaveAttempt } {
  return state.pending !== null && state.pending.requestId === requestId && state.pending.instanceId === state.instanceId;
}

/** Pure transitions retain local keys/text while a request is pending. Nothing
 * retries a write: reconciliation must be an explicit user action. */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "edit": {
      // A persisted story's kind cannot be changed by an editor action.
      const document = copy(action.document);
      document.kind = state.working.kind;
      return { ...state, working: document, error: state.status === "ready" ? null : state.error };
    }
    case "begin-save": {
      if (!canSave(state) || !action.requestId) return state;
      const document = normalizedSnapshot(state.working);
      document.blocks.forEach(Object.freeze);
      Object.freeze(document.blocks); Object.freeze(document);
      const attempt = Object.freeze({ requestId: action.requestId, instanceId: state.instanceId,
        storyId: state.confirmed?.story.id ?? null, expectedVersion: state.confirmed?.story.version ?? null, document });
      return { ...state, lastSent: attempt, pending: attempt, status: "saving", error: null, remote: null };
    }
    case "save-ok": {
      if (!matchesPending(state, action.requestId)) return state;
      const attempt = state.pending;
      if (action.story.kind !== attempt.document.kind || action.story.draftTitle !== attempt.document.title
        || (attempt.storyId !== null && (action.story.id !== attempt.storyId || action.story.version !== attempt.expectedVersion! + 1))
        || (attempt.storyId === null && action.story.version !== 0)) {
        return { ...state, pending: null, status: "uncertain", error: "保存结果无法确认，请先重新读取服务器内容。" };
      }
      // ACK only confirms the sent snapshot. working is deliberately untouched.
      return { ...state, pending: null, confirmed: { story: { ...action.story }, document: copy(attempt.document) },
        status: "ready", error: null, remote: null };
    }
    case "save-error": {
      if (!matchesPending(state, action.requestId)) return state;
      const status = ["conflict", "uncertain", "denied"].includes(action.kind)
        ? action.kind as "conflict" | "uncertain" | "denied" : "ready";
      return { ...state, pending: null, status, error: action.message, remote: null };
    }
    case "access-denied": {
      // Read-side permission checks run only while no save is in flight. A
      // pending save retains its own authoritative, request-correlated outcome.
      if (state.pending !== null) return state;
      return { ...state, status: "denied", remote: null,
        error: action.message ?? "管理权限已失效。你的本地编辑仍然保留，请使用已授权账号重新登录。" };
    }
    case "remote-read": {
      if (state.pending !== null) return state;
      if (state.confirmed && action.detail.story.id !== state.confirmed.story.id) return state;
      if (!state.confirmed && !["uncertain", "conflict"].includes(state.status)) return state;
      if (action.detail.story.kind !== state.working.kind) return state;
      return { ...state, remote: { story: { ...action.detail.story }, draft: {
        title: action.detail.draft.title, content: { version: 1, blocks: action.detail.draft.content.blocks.map(block => ({ ...block })) } } } };
    }
    case "keep-local": {
      if (!state.remote || state.pending !== null) return state;
      // This explicit action accepts the freshly read version for the next CAS,
      // including manual binding after an uncertain create. It never saves.
      const confirmed = { story: { ...state.remote.story }, document: fromDetail(state.remote, state.instanceId) };
      return { ...state, confirmed, status: "ready", error: null, remote: null };
    }
    case "use-remote": {
      if (!state.remote || state.pending !== null) return state;
      const working = fromDetail(state.remote, state.instanceId);
      return { ...state, working, baseline: copy(working), confirmed: { story: { ...state.remote.story }, document: copy(working) },
        status: "ready", error: null, remote: null };
    }
  }
}

export function paragraphBlock(key: string): EditorBlock {
  return { key, type: "paragraph", text: "", style: "normal" };
}

export function imageBlock(key: string): EditorBlock {
  return { key, type: "image", src: EDITOR_SYNTHETIC_IMAGE, alt: "合成星空配图", caption: "" };
}
