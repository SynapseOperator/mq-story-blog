"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent } from "react";
import { readStoryComments, submitStoryComment, StoryCommentError, type PublicCommentPage } from "@/lib/stories/comments-client";
import { canRetryComment, commentLength, freezeCommentAttempt, validateCommentDraft,
  type CommentAttempt, type CommentComposer, type CommentComposerAction } from "@/lib/stories/comment-composer";
import { AccountControls } from "../auth/account-controls";
import { AuthDialog } from "../auth/auth-dialog";
import { useAuth } from "../auth/auth-provider";

type CommentList = {
  phase: "loading" | "ready" | "error" | "unavailable";
  page: PublicCommentPage | null;
  message: string;
};

export function PublishedStoryComments({ storyId, composer, dispatch }: {
  storyId: string; composer: CommentComposer; dispatch: Dispatch<CommentComposerAction>;
}) {
  const { session, status, refresh } = useAuth();
  const [list, setList] = useState<CommentList>({ phase: "loading", page: null, message: "" });
  const [loginOpen, setLoginOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const readRequest = useRef<AbortController | null>(null);
  const writeRequest = useRef<AbortController | null>(null);
  const identity = composer.identity === "auto" ? session ? "account" : "anonymous" : composer.identity;
  const validation = validateCommentDraft(composer.draft);
  const sending = composer.phase === "sending";
  const retryAllowed = composer.attempt !== null && canRetryComment(composer.attempt, session?.user.id ?? null);

  const readPage = useCallback((cursor: string | null = null) => {
    readRequest.current?.abort();
    const request = new AbortController();
    readRequest.current = request;
    return readStoryComments(storyId, cursor, request.signal).then(page => {
      if (readRequest.current !== request || request.signal.aborted) return;
      setList(previous => {
        const existing = cursor ? previous.page?.items ?? [] : [];
        const ids = new Set(existing.map(item => item.id));
        return { phase: "ready", message: "", page: { ...page, items: [...existing, ...page.items.filter(item => !ids.has(item.id))] } };
      });
    }).catch((error: unknown) => {
      if (readRequest.current !== request || request.signal.aborted) return;
      const unavailable = error instanceof StoryCommentError && error.status === 404;
      setList(previous => ({ phase: unavailable ? "unavailable" : "error", page: unavailable ? null : previous.page,
        message: unavailable ? "这篇故事暂未公开或已下架，无法读取留言。" : "留言暂时无法读取，请重试。" }));
    }).finally(() => { if (readRequest.current === request) readRequest.current = null; });
  }, [storyId]);

  useEffect(() => {
    void readPage();
    return () => { readRequest.current?.abort(); readRequest.current = null; };
  }, [readPage]);

  useEffect(() => () => { writeRequest.current?.abort(); writeRequest.current = null; }, []);

  function reload(cursor: string | null = null) {
    setList(previous => ({ ...previous, phase: "loading", message: "" }));
    void readPage(cursor);
  }

  async function send(attempt: CommentAttempt, retry: boolean) {
    if (writeRequest.current || composingRef.current) return;
    const request = new AbortController();
    writeRequest.current = request;
    dispatch(retry ? { type: "retry" } : { type: "send", attempt });
    try {
      await submitStoryComment(attempt.storyId, attempt, attempt.key, request.signal);
      if (writeRequest.current === request && !request.signal.aborted) dispatch({ type: "accepted", key: attempt.key });
    } catch (error) {
      if (writeRequest.current !== request || request.signal.aborted) return;
      const statusCode = error instanceof StoryCommentError ? error.status : null;
      const uncertain = statusCode === null || statusCode >= 500;
      const message = uncertain ? "提交结果暂未确认。请重试原提交，不会重复创建留言。"
        : statusCode === 401 ? "登录已失效，请重新登录后再操作。"
        : statusCode === 404 ? "这篇故事暂未公开或已下架，暂时无法提交留言。"
        : statusCode === 409 ? "这次提交信息发生冲突，请保留内容，不要重复提交。"
        : statusCode === 429 ? error instanceof StoryCommentError && error.retryAfter
          ? `提交较频繁，请 ${error.retryAfter} 秒后再试。` : "提交较频繁，请稍后再试。"
        : statusCode === 403 ? "请求未通过安全检查，请保留内容后重新打开页面。"
        : "留言未被接收，请检查内容后再试。";
      dispatch({ type: "failed", key: attempt.key, uncertain, message });
      if (statusCode === 401) {
        setLoginOpen(true);
        void refresh().catch(() => {});
      }
    } finally { if (writeRequest.current === request) writeRequest.current = null; }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (writeRequest.current || sending || composer.uncertain || composingRef.current || validation
      || status === "loading" || list.phase === "unavailable") return;
    if (identity === "account" && !session) { setLoginOpen(true); return; }
    const attempt = freezeCommentAttempt(composer, storyId, identity, session?.user.id ?? null, crypto.randomUUID());
    void send(attempt, false);
  }

  return <section className="letter-comments" aria-labelledby="letter-comments-title">
    <h3 id="letter-comments-title">留言 <span className="letter-public-comment-count">{list.page?.count ?? "—"}</span></h3>
    <p id="letter-comment-help">留言审核通过后会公开显示。</p>
    <AccountControls reader />
    <form onSubmit={submit} aria-busy={sending}>
      <fieldset className="letter-comment-identity" aria-label="留言身份">
        <legend className="sr-only">留言身份</legend>
        <label><input type="radio" name="letter-comment-identity" value="anonymous" checked={identity === "anonymous"}
          onChange={() => dispatch({ type: "identity", value: "anonymous" })} />匿名留言</label>
        <label><input type="radio" name="letter-comment-identity" value="account" checked={identity === "account"}
          onChange={() => { dispatch({ type: "identity", value: "account" }); if (!session) setLoginOpen(true); }} />账号留言</label>
      </fieldset>
      <p className="letter-comment-author" title={identity === "account" ? session?.user.username : undefined}>
        {identity === "anonymous" ? "将以匿名访客显示" : session ? `将以 ${session.user.username} 显示` : "登录后使用账号留言"}
      </p>
      <label className="sr-only" htmlFor="letter-comment">留言内容</label>
      <textarea id="letter-comment" value={composer.draft} rows={3} aria-describedby="letter-comment-help letter-comment-validation"
        aria-invalid={!composing && Boolean(composer.draft && validation)} placeholder="把想说的话，写在这里……"
        onCompositionStart={() => { composingRef.current = true; setComposing(true); }}
        onCompositionEnd={() => { composingRef.current = false; setComposing(false); }}
        onChange={event => dispatch({ type: "edit", value: event.target.value })} />
      <div className="letter-comment-actions">
        <span>{commentLength(composer.draft)} / 500</span>
        <button type="submit" disabled={sending || composer.uncertain || composing || Boolean(validation)
          || status === "loading" || list.phase === "unavailable"}>{sending ? "正在提交…" : "提交留言"}</button>
      </div>
      <p id="letter-comment-validation" className="letter-comment-validation" role="status">{!composing && composer.draft ? validation : ""}</p>
    </form>
    <div className="letter-comment-submit-status" data-state={composer.phase} role={composer.phase === "error" || composer.uncertain ? "alert" : "status"}>
      {sending ? "正在提交这次留言，你可以继续编辑。" : composer.message}
      {composer.uncertain && !sending ? <p>上次请求的结果仍未确认。继续编辑不会改变重试的内容。</p> : null}
    </div>
    {composer.uncertain && composer.attempt ? <div className="letter-comment-recovery">
      <details><summary>查看原提交内容</summary><p>{composer.attempt.body}</p>
        <small>{composer.attempt.identity === "anonymous" ? "匿名留言" : "账号留言"}</small></details>
      {!retryAllowed ? <p>请登录原账号后重试这次提交。</p> : null}
      <button type="button" disabled={sending || !retryAllowed || composing} onClick={() => {
        if (composer.attempt && retryAllowed) void send(composer.attempt, true);
      }}>重试原提交</button>
      {!retryAllowed && !session ? <button type="button" onClick={() => setLoginOpen(true)}>重新登录</button> : null}
    </div> : null}
    <div className="letter-comments-read-status" data-state={list.phase} role={list.phase === "error" || list.phase === "unavailable" ? "alert" : "status"}>
      {list.phase === "loading" ? "正在读取留言…" : list.message || (list.page?.count === 0 ? "还没有公开留言。" : "")}
    </div>
    <ol className="letter-comment-list">
      {list.page?.items.map(item => <li key={item.id} className="letter-comment-item" data-comment-id={item.id}>
        <div><strong>{item.author}</strong><time dateTime={item.createdAt}>{item.createdAt.slice(0, 10)}</time></div>
        <p>{item.body}</p>
      </li>)}
    </ol>
    <div className="letter-comment-list-actions">
      <button type="button" disabled={list.phase === "loading"} onClick={() => reload()}>重新读取留言</button>
      {list.page?.nextCursor ? <button type="button" disabled={list.phase === "loading"}
        onClick={() => reload(list.page?.nextCursor)}>加载更多留言</button> : null}
    </div>
    {loginOpen ? <AuthDialog initialMode="login" appearance="reader" onClosed={() => setLoginOpen(false)} /> : null}
  </section>;
}
