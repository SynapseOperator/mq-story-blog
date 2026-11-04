import { EDITOR_SYNTHETIC_IMAGE, type DraftDetail, type DraftRevision, type DraftSummary,
  type EditorBlock, type EditorDocument, type FailureKind, type PublicationAck, type PublicationAction, type StoryKind } from "./types.ts";

export type SaveAttempt = Readonly<{
  requestId: string;
  instanceId: string;
  storyId: string | null;
  expectedVersion: number | null;
  document: EditorDocument;
}>;
export type PublicationAttempt = Readonly<{
  requestId: string;
  instanceId: string;
  storyId: string;
  expectedVersion: number;
  action: PublicationAction;
  slotId?: string | null;
}>;
export type EditorState = {
  instanceId: string;
  working: EditorDocument;
  baseline: EditorDocument;
  confirmed: { story: DraftSummary; document: EditorDocument } | null;
  lastSent: SaveAttempt | null;
  pending: SaveAttempt | null;
  publication: PublicationAttempt | null;
  lastPublication: PublicationAttempt | null;
  status: "ready" | "saving" | "publishing" | "conflict" | "uncertain" | "denied";
  error: string | null;
  remote: DraftDetail | null;
};
export type EditorAction =
  | { type: "edit"; document: EditorDocument }
  | { type: "select-media"; instanceId: string; blockKey: string | null; assetId: string; newBlockKey: string }
  | { type: "begin-save"; requestId: string }
  | { type: "save-ok"; requestId: string; story: DraftSummary }
  | { type: "save-error"; requestId: string; kind: FailureKind; message: string }
  | { type: "begin-publication"; requestId: string; action: PublicationAction; slotId?: string | null }
  | { type: "publication-ok"; requestId: string; story: PublicationAck }
  | { type: "publication-error"; requestId: string; kind: FailureKind; message: string }
  | { type: "access-denied"; message?: string }
  | { type: "remote-read"; detail: DraftDetail }
  | { type: "keep-local" }
  | { type: "use-remote" };

function copy(document: EditorDocument): EditorDocument {
  return { kind: document.kind, title: document.title, contentVersion: document.contentVersion,
    blocks: document.blocks.map(block => ({ ...block })) };
}

function normalized(document: EditorDocument) {
  const asset = document.blocks.some(block => block.type === "image" && "assetId" in block);
  const legacy = document.blocks.some(block => block.type === "image" && "src" in block);
  return { title: document.title.trim(), content: {
    version: asset ? 2 as const : legacy ? 1 as const : document.contentVersion ?? 1,
    blocks: document.blocks.map(block =>
    block.type === "paragraph"
      ? { type: "paragraph" as const, text: block.text, style: block.style ?? "normal" }
      : { type: "image" as const, ...("assetId" in block ? { assetId: block.assetId } : { src: block.src }), alt: block.alt,
        ...(block.caption?.trim() ? { caption: block.caption } : {}) }) } };
}

/** Exact write payload. The mixed migration state stays in memory, never HTTP. */
export function toRevision(document: EditorDocument): DraftRevision {
  const result = normalized(document);
  if (result.content.version === 2 && result.content.blocks.some(block => "src" in block)) {
    throw new Error("Replace legacy images before saving version 2");
  }
  return result as DraftRevision;
}

function same(left: EditorDocument, right: EditorDocument): boolean {
  return left.kind === right.kind && JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function fromDetail(detail: DraftDetail, instanceId: string): EditorDocument {
  return { kind: detail.story.kind, title: detail.draft.title, contentVersion: detail.draft.content.version,
    blocks: detail.draft.content.blocks.map((block, index) => ({ ...block, key: `${instanceId}-block-${index}` })) };
}

/** instanceId is generated at a client event/mount, never during SSR rendering. */
export function createEditor(kind: StoryKind, instanceId = globalThis.crypto.randomUUID()): EditorState {
  const working: EditorDocument = { kind, title: "", contentVersion: 2,
    blocks: [{ key: `${instanceId}-block-0`, type: "paragraph", text: "", style: "normal" }] };
  return { instanceId, working, baseline: copy(working), confirmed: null,
    lastSent: null, pending: null, publication: null, lastPublication: null, status: "ready", error: null, remote: null };
}

export function openEditor(detail: DraftDetail, instanceId = globalThis.crypto.randomUUID()): EditorState {
  const working = fromDetail(detail, instanceId);
  return { instanceId, working, baseline: copy(working),
    confirmed: { story: { ...detail.story }, document: copy(working) },
    lastSent: null, pending: null, publication: null, lastPublication: null, status: "ready", error: null, remote: null };
}

export function isDirty(state: EditorState): boolean {
  return !same(state.working, state.confirmed?.document ?? state.baseline);
}

export function needsLeaveProtection(state: EditorState): boolean {
  return isDirty(state) || state.pending !== null || state.publication !== null || state.status === "uncertain" || state.status === "conflict";
}

export function validateDocument(document: EditorDocument): string | null {
  if (!["STAR", "CAMPFIRE"].includes(document.kind)) return "请选择故事类型。";
  if (!document.title.trim() || document.title.length > 160 || document.title.includes("\0")) return "标题不能为空，且最多 160 个字符。";
  if (document.blocks.length < 1 || document.blocks.length > 200) return "正文需要 1 至 200 个内容块。";
  if (document.blocks.some(block => block.type === "image" && "assetId" in block)
    && document.blocks.some(block => block.type === "image" && "src" in block)) {
    return "已加入素材图片。请逐一替换剩余的旧合成图片，再保存；原图片不会自动导入或删除。";
  }
  const keys = new Set<string>();
  for (const block of document.blocks) {
    if (!block.key || keys.has(block.key)) return "内容块标识异常，请保留文本并重新读取草稿。";
    keys.add(block.key);
    if (block.type === "paragraph") {
      if (!block.text.trim() || block.text.length > 10000 || block.text.includes("\0")) return "每段文字不能为空，且最多 10000 个字符。";
      if (block.style !== undefined && !["normal", "emphasis", "strong"].includes(block.style)) return "段落样式暂不支持。";
    } else if (block.type === "image") {
      if ("assetId" in block) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(block.assetId)) return "请选择处理完成的素材图片。";
      } else if (block.src !== EDITOR_SYNTHETIC_IMAGE) return "旧图片仅支持已有的合成星空图片，请从素材库重新选择。";
      if (!block.alt.trim() || block.alt.length > 300 || block.alt.includes("\0")) return "请填写图片说明，最多 300 个字符。";
      if ((block.caption?.length ?? 0) > 1000 || block.caption?.includes("\0")) return "图片附注最多 1000 个字符。";
    } else return "正文仅支持段落和图片。";
  }
  if (new TextEncoder().encode(JSON.stringify(toRevision(document).content)).byteLength > 256 * 1024) return "正文过长，请缩短至 256 KiB 以内。";
  return null;
}

export function canSave(state: EditorState): boolean {
  return state.status === "ready" && state.pending === null && state.publication === null && (isDirty(state) || state.confirmed === null)
    && validateDocument(state.working) === null;
}

/** UI eligibility only. The existing server checks lifecycle, slots and authority. */
export function canPublishAction(state: EditorState, action: PublicationAction): boolean {
  if (state.status !== "ready" || state.pending || state.publication || !state.confirmed) return false;
  const story = state.confirmed.story;
  switch (action) {
    case "slot": return story.kind === "STAR" && story.state === "DRAFT";
    case "publish": return story.state !== "WITHDRAWN" && story.hasUnpublishedChanges && !isDirty(state);
    case "withdraw": return story.state === "PUBLISHED";
    case "restore": return story.state === "WITHDRAWN";
  }
}

function normalizedSnapshot(document: EditorDocument): EditorDocument {
  const revision = toRevision(document);
  return { kind: document.kind, title: revision.title, contentVersion: revision.content.version,
    blocks: revision.content.blocks.map((block, index) => ({ ...block, key: document.blocks[index].key })) };
}

function matchesPending(state: EditorState, requestId: string): state is EditorState & { pending: SaveAttempt } {
  return state.pending !== null && state.pending.requestId === requestId && state.pending.instanceId === state.instanceId;
}

/** Pure transitions retain local keys/text while a request is pending. Nothing
 * retries a write: reconciliation must be an explicit user action. */
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "select-media": {
      if (action.instanceId !== state.instanceId || state.status === "denied") return state;
      const previous = action.blockKey === null ? null : state.working.blocks.find(block => block.key === action.blockKey);
      if (action.blockKey !== null && previous?.type !== "image") return state;
      if (action.blockKey === null && state.working.blocks.length >= 200) return state;
      const image = { key: previous?.key ?? action.newBlockKey,
        type: "image" as const, assetId: action.assetId, alt: previous?.type === "image" ? previous.alt : "",
        ...(previous?.type === "image" && previous.caption !== undefined ? { caption: previous.caption } : {}) };
      const document = { ...state.working, contentVersion: 2 as const, blocks: previous
        ? state.working.blocks.map(block => block.key === previous.key ? image : block) : [...state.working.blocks, image] };
      return { ...state, working: document, error: state.status === "ready" ? null : state.error };
    }
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
      return { ...state, lastSent: attempt, pending: attempt, lastPublication: null, status: "saving", error: null, remote: null };
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
    case "begin-publication": {
      if (!action.requestId || !canPublishAction(state, action.action)
        || (action.action === "slot" && action.slotId === undefined)) return state;
      const attempt = Object.freeze({ requestId: action.requestId, instanceId: state.instanceId,
        storyId: state.confirmed!.story.id, expectedVersion: state.confirmed!.story.version,
        action: action.action, ...(action.action === "slot" ? { slotId: action.slotId } : {}) });
      return { ...state, publication: attempt, lastPublication: attempt,
        status: "publishing", error: null, remote: null };
    }
    case "publication-ok": {
      const attempt = state.publication;
      if (!attempt || attempt.requestId !== action.requestId || attempt.instanceId !== state.instanceId) return state;
      const expectedState = attempt.action === "slot" ? "DRAFT" : attempt.action === "withdraw" ? "WITHDRAWN" : "PUBLISHED";
      if (action.story.id !== attempt.storyId || action.story.version !== attempt.expectedVersion + 1
        || action.story.state !== expectedState
        || (attempt.action === "slot" && action.story.slotId !== attempt.slotId)
        || action.story.hasUnpublishedChanges !== (attempt.action === "publish" ? false : state.confirmed!.story.hasUnpublishedChanges)) {
        return { ...state, publication: null, status: "uncertain", error: "发布操作结果无法确认，请先核对服务器状态。" };
      }
      const { version, state: publishedState, hasUnpublishedChanges } = action.story;
      // Publication changes no draft bytes. Keep the confirmed content and any
      // typing since the request; only advance the server's CAS and public state.
      return { ...state, publication: null, confirmed: { ...state.confirmed!,
        story: { ...state.confirmed!.story, version, state: publishedState, hasUnpublishedChanges } },
        status: "ready", error: null, remote: null };
    }
    case "publication-error": {
      if (!state.publication || state.publication.requestId !== action.requestId
        || state.publication.instanceId !== state.instanceId) return state;
      const status = ["conflict", "uncertain", "denied"].includes(action.kind)
        ? action.kind as "conflict" | "uncertain" | "denied" : "ready";
      return { ...state, publication: null, status, error: action.message, remote: null };
    }
    case "access-denied": {
      // Pending writes retain their own authoritative, request-correlated
      // outcome; a concurrent read cannot replace that result.
      if (state.pending !== null || state.publication !== null) return state;
      return { ...state, status: "denied", remote: null,
        error: action.message ?? "管理权限已失效。你的本地编辑仍然保留，请使用已授权账号重新登录。" };
    }
    case "remote-read": {
      if (state.pending !== null || state.publication !== null) return state;
      if (state.confirmed && action.detail.story.id !== state.confirmed.story.id) return state;
      if (!state.confirmed && !["uncertain", "conflict"].includes(state.status)) return state;
      if (action.detail.story.kind !== state.working.kind) return state;
      return { ...state, remote: globalThis.structuredClone(action.detail) };
    }
    case "keep-local": {
      if (!state.remote || state.pending !== null || state.publication !== null) return state;
      // This explicit action accepts the freshly read version for the next CAS,
      // including manual binding after an uncertain create. It never saves.
      const confirmed = { story: { ...state.remote.story }, document: fromDetail(state.remote, state.instanceId) };
      return { ...state, confirmed, status: "ready", error: null, remote: null, lastPublication: null };
    }
    case "use-remote": {
      if (!state.remote || state.pending !== null || state.publication !== null) return state;
      const working = fromDetail(state.remote, state.instanceId);
      return { ...state, working, baseline: copy(working), confirmed: { story: { ...state.remote.story }, document: copy(working) },
        status: "ready", error: null, remote: null, lastPublication: null };
    }
  }
}

export function paragraphBlock(key: string): EditorBlock {
  return { key, type: "paragraph", text: "", style: "normal" };
}

export function imageBlock(key: string): EditorBlock {
  return { key, type: "image", src: EDITOR_SYNTHETIC_IMAGE, alt: "合成星空配图", caption: "" };
}
