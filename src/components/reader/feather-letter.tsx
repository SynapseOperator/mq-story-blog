"use client";

import { useCallback, useEffect, useImperativeHandle, useReducer, useRef, useState, type CSSProperties, type Ref } from "react";
import type { Story, LetterContentState, LetterPreviewSnapshot } from "@/lib/stories/story";
import { AccountControls } from "../auth/account-controls";
import { PublishedStoryLike } from "./published-story-like";
import { PublishedStoryComments } from "./published-story-comments";
import { commentComposerReducer, commentNeedsProtection, createCommentComposer } from "@/lib/stories/comment-composer";

type ReaderPhase = "opening" | "reading" | "closing";

// Prototype timings, coordinated with CSS. These are not final product parameters.
const OPEN_DURATION = 1000;
const CLOSE_DURATION = 400;

function LetterImage({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [failed, setFailed] = useState(false);
  return <figure className="letter-photo">
    {failed ? <div className="letter-image-fallback" role="status">
      <span>配图暂时无法显示，正文仍可继续阅读。</span>
      <button type="button" onClick={() => setFailed(false)}>重试图片</button>
    </div> : <img src={src} alt={alt} width="768" height="512" loading="lazy" decoding="async"
      referrerPolicy="no-referrer" onError={() => setFailed(true)} />}
    {caption ? <figcaption>{caption}</figcaption> : null}
  </figure>;
}

function StructuredBlocks({ blocks, storyId }: { blocks: LetterPreviewSnapshot["content"]["blocks"]; storyId?: string }) {
  return blocks.map((block, index) => block.type === "image"
    ? <LetterImage key={`${index}-${"assetId" in block ? block.assetId : block.src}`} {...block}
      src={"assetId" in block ? storyId ? `/api/stories/${storyId}/media/${block.assetId}`
        : `/api/admin/media/${block.assetId}/content` : block.src} />
    : <p key={index}>{block.style === "strong" ? <strong>{block.text}</strong>
      : block.style === "emphasis" ? <em>{block.text}</em> : block.text}</p>);
}

function LetterProse({ story }: { story: Story }) {
  return <article className="letter-prose" aria-label={story.title}>
    {story.source === "synthetic-demo" ? <>
      <blockquote>{story.introduction}</blockquote>
      <p>{story.paragraphs[0]}</p>
      <LetterImage {...story.image} />
      {story.paragraphs.slice(1).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      <p className="letter-signature">{story.closing}</p>
    </> : <StructuredBlocks blocks={story.content.blocks} storyId={story.id} />}
  </article>;
}

export type LetterNavigationHandle = { requestClose: () => boolean };

type FeatherLetterProps = {
  mode?: "public";
  entry: { id: string; title: string };
  content: LetterContentState;
  onRetry: () => void;
  onClosed: () => void;
  onCloseCancelled?: () => void;
  navigationRef?: Ref<LetterNavigationHandle>;
} | {
  mode: "private-preview";
  snapshot: LetterPreviewSnapshot;
  onClosed: () => void;
};

export function FeatherLetter(props: FeatherLetterProps) {
  const { onClosed } = props;
  const snapshot = props.mode === "private-preview" ? props.snapshot : null;
  const content = props.mode === "private-preview" ? null : props.content;
  const story = content?.status === "ready" ? content.story : null;
  const title = props.mode === "private-preview"
    ? props.snapshot.title.trim() ? props.snapshot.title : "未填写标题"
    : story?.title ?? props.entry.title;
  const navigationRef = props.mode === "private-preview" ? undefined : props.navigationRef;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmationRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const phaseRef = useRef<ReaderPhase>("opening");
  const reducedMotion = useRef(false);
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusFrame = useRef<number | null>(null);
  const finished = useRef(false);
  const backdropPress = useRef(false);
  const [phase, setPhase] = useState<ReaderPhase>("opening");
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [liked, setLiked] = useState(false);
  const [composer, dispatchComment] = useReducer(commentComposerReducer, undefined, createCommentComposer);
  const protectComments = Boolean(draft.trim()) || commentNeedsProtection(composer);

  useEffect(() => {
    if (!protectComments) return;
    // Cross-document Back/Forward, refresh and closing the tab use the browser's
    // own confirmation. Draft text is never stored in history or localStorage.
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [protectComments]);

  useImperativeHandle(navigationRef, () => ({ requestClose }));

  const finishClose = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    if (transitionTimer.current !== null) clearTimeout(transitionTimer.current);
    confirmationRef.current?.close();
    dialogRef.current?.close();
    onClosed();
  }, [onClosed]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousScroll = { x: window.scrollX, y: window.scrollY };
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    finished.current = false;
    dialog.showModal();

    function finishOpening() {
      if (phaseRef.current !== "opening") return;
      phaseRef.current = "reading";
      setPhase("reading");
      // Wait for React to remove disabled/inert before restoring keyboard focus.
      focusFrame.current = requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    }

    function updateMotion() {
      reducedMotion.current = media.matches;
      if (!media.matches) return;
      if (transitionTimer.current !== null) clearTimeout(transitionTimer.current);
      if (phaseRef.current === "closing") finishClose();
      else finishOpening();
    }

    reducedMotion.current = media.matches;
    // A timer also finishes transitions if animations are disabled by browser tools.
    transitionTimer.current = setTimeout(
      phaseRef.current === "closing" ? finishClose : finishOpening,
      media.matches ? 0 : phaseRef.current === "closing" ? CLOSE_DURATION : OPEN_DURATION,
    );
    media.addEventListener("change", updateMotion);
    return () => {
      media.removeEventListener("change", updateMotion);
      if (transitionTimer.current !== null) clearTimeout(transitionTimer.current);
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
      dialog.close();
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      if (window.scrollX !== previousScroll.x || window.scrollY !== previousScroll.y) {
        window.scrollTo(previousScroll.x, previousScroll.y);
      }
    };
  }, [finishClose]);

  function beginClose() {
    if (phaseRef.current !== "reading") return;
    phaseRef.current = "closing";
    setPhase("closing");
    if (transitionTimer.current !== null) clearTimeout(transitionTimer.current);
    transitionTimer.current = setTimeout(finishClose, reducedMotion.current ? 0 : CLOSE_DURATION);
  }

  function requestClose() {
    if (phaseRef.current !== "reading" || confirmationRef.current?.open
      || dialogRef.current?.querySelector(".auth-dialog[open]")) return false;
    if (protectComments) {
      confirmationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirming(true);
      confirmationRef.current?.showModal();
      continueRef.current?.focus({ preventScroll: true });
    } else beginClose();
    return true;
  }

  function continueEditing() {
    confirmationRef.current?.close();
    setConfirming(false);
    if (props.mode !== "private-preview") props.onCloseCancelled?.();
    // The previous control may be in the temporarily inert reading content.
    focusFrame.current = requestAnimationFrame(() => confirmationTrigger.current?.focus({ preventScroll: true }));
  }

  function discardAndClose() {
    confirmationRef.current?.close();
    setConfirming(false);
    beginClose();
  }

  return (
    <dialog ref={dialogRef} className="letter-dialog" data-phase={phase} data-mode={props.mode ?? "public"}
      data-story-id={props.mode === "private-preview" ? undefined : props.entry.id}
      aria-labelledby="letter-title" aria-describedby="letter-demo-note" aria-busy={phase !== "reading" || content?.status === "loading"}
      style={{ "--letter-open-duration": `${OPEN_DURATION}ms`, "--letter-close-duration": `${CLOSE_DURATION}ms` } as CSSProperties}
      onCancel={(event) => { event.preventDefault(); if (event.target === event.currentTarget) requestClose(); }}
      onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        if (event.target === event.currentTarget && backdropPress.current) requestClose();
        backdropPress.current = false;
      }}>
      <div className="letter-sheet">
        <div className="letter-paper" aria-hidden="true" />
        <img className="letter-feather" src="/letter/quill.webp" alt="" aria-hidden="true" />
        <img className="letter-postmark" src="/letter/butterfly-postmark.webp" alt="" aria-hidden="true" />
        <button ref={closeRef} type="button" className="letter-close" aria-label={snapshot ? "关闭预览" : "关闭羽毛信"}
          disabled={phase !== "reading" || confirming} onClick={requestClose}>×</button>
        <div className="letter-scroll" tabIndex={0} aria-label="信纸阅读内容" inert={phase !== "reading" || confirming}>
          <header className="letter-heading">
            <h2 id="letter-title">{title}</h2>
            <p className="letter-meta">{story?.source === "synthetic-demo" ? <span>{story.date}</span> : null}
              <span>{snapshot ? "管理员私有预览 · 未发布" : story?.source === "synthetic-demo" ? "MQ 演示书信" : "MQ 公开书信"}</span></p>
            <p id="letter-demo-note" className="letter-demo-note">{snapshot
              ? snapshot.hasUnsavedChanges ? "包含未保存修改 · 预览不会保存或发布" : "仅预览当前编辑内容 · 不会保存或发布"
              : story?.source === "synthetic-demo"
              ? "合成演示 · 非真实回忆" : "登录后可以点赞，也可以留下留言"}</p>
          </header>
          {props.mode !== "private-preview" && content && content.status !== "ready" ? <div className="letter-load-state"
            data-state={content.status === "loading" ? "loading" : content.unavailable ? "not-found" : "error"}
            role={content.status === "loading" ? "status" : "alert"}>
            <p>{content.status === "loading" ? "正在展开这封信的内容……" : content.unavailable
              ? "这篇故事暂未公开或已下架。你可以重试，或关闭信纸返回星空。"
              : "故事加载失败，请检查网络后重试。也可以关闭信纸，稍后再来。"}</p>
            {content.status === "error" ? <button type="button" aria-label="重试加载故事" onClick={props.onRetry}>重试</button> : null}
          </div> : null}
          {snapshot ? <article className="letter-prose" aria-label={title}>
            {snapshot.content.blocks.some(block => block.type === "image" || block.text.trim())
              ? <StructuredBlocks blocks={snapshot.content.blocks} />
              : <p>正文尚未填写。关闭预览后，可以继续编辑；这里不会保存或发布内容。</p>}
          </article> : null}
          {story ? <>
          <LetterProse story={story} />
          <div className="letter-divider" aria-hidden="true" />
          {story.source === "published" ? <PublishedStoryLike storyId={story.id} /> : <div className="letter-reactions">
            <button type="button" className="letter-like" aria-pressed={liked} onClick={() => setLiked(!liked)}>
              <span aria-hidden="true">{liked ? "♥" : "♡"}</span>演示点赞 <span>{liked ? 1 : 0}</span>
            </button>
            <span className="letter-comment-count">留言示例 1</span>
            <span className="letter-reaction-note">仅本次阅读有效，不会发送</span>
          </div>}
          {story.source === "published" ? <PublishedStoryComments storyId={story.id} composer={composer} dispatch={dispatchComment} />
          : <section className="letter-comments" aria-labelledby="letter-comments-title">
            <h3 id="letter-comments-title">留言</h3>
            <p id="letter-comment-help">留言仅供演示，不会发送或保存。</p>
            <AccountControls reader />
            <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) setPreview(draft); }}>
              <label className="sr-only" htmlFor="letter-comment">演示留言</label>
              <textarea id="letter-comment" value={draft} rows={3} maxLength={500}
                aria-describedby="letter-comment-help" placeholder="把想说的话，写在这里……"
                onChange={(event) => { setDraft(event.target.value); setPreview(null); }} />
              <div className="letter-comment-actions">
                <span>{draft.length} / 500</span>
                <button type="submit" disabled={!draft.trim()}>预览留言（不发送）</button>
              </div>
            </form>
            <div className="letter-comment-preview" role="status" aria-live="polite">
              {preview !== null ? <><h4>你的预览 · 未发送</h4><p>{preview}</p><small>输入仍保留，关闭时会询问是否放弃。</small></> : null}
            </div>
            <div className="letter-sample-comment">
              <span className="letter-comment-avatar" aria-hidden="true">星</span>
              <div>
                <p><strong>演示访客</strong><span>合成示例</span></p>
                <p>愿每一个平凡的夜晚，都有值得收藏的微光。</p>
              </div>
            </div>
          </section>}
          <p className="letter-end">这一页的故事，暂且写到这里。</p>
          </> : null}
        </div>
      </div>
      {props.mode !== "private-preview" ? <dialog ref={confirmationRef} className="letter-discard" role="alertdialog"
        aria-labelledby="letter-discard-title" aria-describedby="letter-discard-description"
        onCancel={(event) => { event.preventDefault(); event.stopPropagation(); continueEditing(); }}>
        <h2 id="letter-discard-title">要放下这封信吗？</h2>
        <p id="letter-discard-description">{story?.source === "synthetic-demo"
          ? "演示留言尚未提交。关闭后，这次输入和预览会被清除。"
          : composer.phase === "sending" || composer.uncertain
          ? "这次提交的结果尚未确认。关闭会清除输入和本次重试信息，但不会撤回已经发送的请求。"
          : "还有未提交的留言。关闭后，这次输入会被清除。"}</p>
        <div className="letter-discard-actions">
          <button ref={continueRef} type="button" onClick={continueEditing}>继续编辑</button>
          <button type="button" onClick={discardAndClose}>放弃并关闭</button>
        </div>
      </dialog> : null}
    </dialog>
  );
}
