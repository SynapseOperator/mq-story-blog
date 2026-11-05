import type { CommentIdentity } from "./comments-client.ts";

export type CommentAttempt = Readonly<{
  storyId: string; key: string; body: string; identity: CommentIdentity;
  accountUserId: string | null; draftRevision: number;
}>;
export type CommentComposer = {
  draft: string;
  revision: number;
  identity: "auto" | CommentIdentity;
  phase: "idle" | "sending" | "uncertain" | "accepted" | "error";
  attempt: CommentAttempt | null;
  uncertain: boolean;
  message: string;
};
export type CommentComposerAction =
  | { type: "edit"; value: string }
  | { type: "identity"; value: CommentIdentity }
  | { type: "send"; attempt: CommentAttempt }
  | { type: "retry" }
  | { type: "accepted"; key: string }
  | { type: "failed"; key: string; uncertain: boolean; message: string };

export function createCommentComposer(): CommentComposer {
  return { draft: "", revision: 0, identity: "auto", phase: "idle", attempt: null, uncertain: false, message: "" };
}

export function commentLength(draft: string) { return [...draft.trim()].length; }

/** The browser checks user input once before sending; the server remains authoritative. */
export function validateCommentDraft(draft: string): string | null {
  if (!draft.isWellFormed() || /\p{Cc}/u.test(draft.replace(/[\t\n\r]/g, ""))) return "留言含有无法使用的字符，请修改后再提交。";
  const length = commentLength(draft);
  if (!length) return "请先写下留言。";
  if (length > 500) return "留言最多 500 个字，请缩短后再提交。";
  return null;
}

export function commentNeedsProtection(state: CommentComposer) {
  return Boolean(state.draft.trim()) || state.phase === "sending" || state.uncertain;
}

export function freezeCommentAttempt(state: CommentComposer, storyId: string, identity: CommentIdentity, userId: string | null, key: string): CommentAttempt {
  return Object.freeze({ storyId, key, body: state.draft.trim(), identity,
    accountUserId: identity === "account" ? userId : null, draftRevision: state.revision });
}

export function canRetryComment(attempt: CommentAttempt, userId: string | null) {
  return attempt.identity === "anonymous" || (attempt.accountUserId !== null && attempt.accountUserId === userId);
}

export function commentComposerReducer(state: CommentComposer, action: CommentComposerAction): CommentComposer {
  switch (action.type) {
    case "edit": return { ...state, draft: action.value, revision: state.revision + 1,
      ...(!state.attempt ? { phase: "idle" as const, message: "" } : {}) };
    case "identity": return { ...state, identity: action.value };
    case "send":
      if (state.phase === "sending" || state.uncertain) return state;
      return { ...state, attempt: action.attempt, phase: "sending", uncertain: false, message: "" };
    case "retry":
      if (!state.attempt || !state.uncertain || state.phase === "sending") return state;
      return { ...state, phase: "sending", message: "" };
    case "accepted":
      if (state.attempt?.key !== action.key || state.phase !== "sending") return state;
      return { ...state, draft: state.revision === state.attempt.draftRevision ? "" : state.draft,
        phase: "accepted", attempt: null, uncertain: false, message: "留言已提交，审核通过后会显示" };
    case "failed": {
      if (state.attempt?.key !== action.key || state.phase !== "sending") return state;
      // A later rejection does not establish the outcome of an earlier lost response.
      const uncertain = state.uncertain || action.uncertain;
      return { ...state, phase: uncertain ? "uncertain" : "error", uncertain,
        attempt: uncertain ? state.attempt : null, message: action.message };
    }
  }
}
