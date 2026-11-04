"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestStoryLikes, StoryLikeError, type StoryLikeState } from "@/lib/stories/likes-client";
import { AuthDialog } from "../auth/auth-dialog";
import { useAuth } from "../auth/auth-provider";

type LikeView = {
  scope: string;
  phase: "loading" | "ready" | "saving" | "checking" | "error" | "unavailable";
  value: StoryLikeState | null;
  error: string;
  uncertain?: boolean;
};

export function PublishedStoryLike({ storyId }: { storyId: string }) {
  const { session, status, refresh } = useAuth();
  const scope = `${storyId}:${status}:${session?.user.id ?? ""}:${session?.session.expiresAt ?? ""}`;
  const [view, setView] = useState<LikeView>({ scope, phase: "loading", value: null, error: "" });
  const [loginOpen, setLoginOpen] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const likeRef = useRef<HTMLButtonElement>(null);
  const restoreLikeFocus = useRef(false);
  // A previous user's pressed state is never shown while their replacement is loading.
  const current: LikeView = view.scope === scope ? view : { scope, phase: "loading", value: null, error: "" };

  const readState = useCallback((uncertain = false) => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    return requestStoryLikes(storyId, "GET", request.signal).then(value => {
      if (!request.signal.aborted && requestRef.current === request) setView({ scope, phase: "ready", value, error: "", uncertain });
    }).catch((error: unknown) => {
      if (request.signal.aborted || requestRef.current !== request) return;
      const unavailable = error instanceof StoryLikeError && error.status === 404;
      setView(previous => ({ scope, phase: unavailable ? "unavailable" : "error",
        value: previous.scope === scope ? previous.value : null,
        uncertain,
        error: unavailable ? "这篇故事暂未公开或已下架，暂时无法点赞。"
          : uncertain ? "请求结果仍未确认。请重新读取点赞状态后再操作。" : "点赞状态暂时无法读取，请重试。" }));
    }).finally(() => {
      if (requestRef.current === request) requestRef.current = null;
    });
  }, [storyId, scope]);

  useEffect(() => {
    if (status === "loading") return;
    void readState();
    return () => { requestRef.current?.abort(); requestRef.current = null; };
  }, [status, readState]);

  useEffect(() => {
    // Successful login may finish before its new-user GET. Restore the heart's
    // focus once that request enables it; the enclosing reader stays mounted.
    if (!loginOpen && current.phase === "ready" && restoreLikeFocus.current) {
      restoreLikeFocus.current = false;
      likeRef.current?.focus({ preventScroll: true });
    }
  }, [loginOpen, current.phase]);

  async function changeLike() {
    if (requestRef.current || current.phase !== "ready" || !current.value) return;
    if (!session) { setLoginOpen(true); return; }
    const request = new AbortController();
    requestRef.current = request;
    setView({ ...current, phase: "saving", error: "" });
    try {
      const value = await requestStoryLikes(storyId, current.value.liked ? "DELETE" : "PUT", request.signal);
      if (!request.signal.aborted && requestRef.current === request) setView({ scope, phase: "ready", value, error: "" });
    } catch (error) {
      if (request.signal.aborted || requestRef.current !== request) return;
      if (error instanceof StoryLikeError && error.status === 401) {
        setView({ ...current, phase: "error", error: "登录已失效，请重新登录后再点赞。" });
        setLoginOpen(true);
        void refresh().catch(() => {});
      } else if (error instanceof StoryLikeError && error.status === 404) {
        setView({ ...current, phase: "unavailable", error: "这篇故事暂未公开或已下架，暂时无法点赞。" });
      } else if (error instanceof StoryLikeError && error.status !== null && error.status < 500) {
        setView({ ...current, phase: "ready", error: error.status === 403
          ? "请求未通过安全检查，请刷新页面后重试。" : "这次点赞操作未完成，请稍后再试。" });
      } else {
        // The server may have committed before its response was lost. Only read;
        // never repeat the write or infer success by reversing the old value.
        setView({ ...current, phase: "checking", error: "" });
        await readState(true);
      }
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
  }

  const pending = current.phase === "loading" || current.phase === "saving" || current.phase === "checking";
  return <div className="letter-reactions" data-state={current.phase}>
    <button ref={likeRef} type="button" className="letter-like" aria-label={current.value?.liked ? "取消点赞" : "点赞"}
      aria-pressed={current.value?.liked} aria-busy={pending} disabled={current.phase !== "ready"}
      onClick={() => void changeLike()}>
      <span aria-hidden="true">{current.value?.liked ? "♥" : "♡"}</span>
      {current.value?.liked ? "已点赞" : "点赞"} <span className="letter-like-count">{current.value?.count ?? "—"}</span>
    </button>
    <span className="letter-comment-count">留言示例 1</span>
    <span className="letter-reaction-note">留言仅供演示，不会发送</span>
    <span className="letter-like-status" role={current.error ? "alert" : "status"}>
      {current.phase === "loading" ? "正在读取点赞状态…" : current.phase === "saving" ? "正在保存点赞状态…"
        : current.phase === "checking" ? "请求结果暂未确认，正在核对点赞状态…"
        : current.error || (current.uncertain ? "已读取当前状态；上次请求结果未确认。" : "")}
    </span>
    {current.phase === "error" || current.phase === "unavailable" || (current.phase === "ready" && current.uncertain)
      ? <button type="button" className="letter-like-retry" onClick={() => {
        setView({ ...current, phase: "loading", error: "" }); void readState(current.uncertain);
      }}>重新读取点赞状态</button> : null}
    {loginOpen ? <AuthDialog initialMode="login" onClosed={() => { restoreLikeFocus.current = true; setLoginOpen(false); }} /> : null}
  </div>;
}
