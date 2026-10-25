"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { Story } from "@/lib/stories/story";
import { AccountControls } from "../auth/account-controls";

type ReaderPhase = "opening" | "reading" | "closing";

// Prototype timings, coordinated with CSS. These are not final product parameters.
const OPEN_DURATION = 1000;
const CLOSE_DURATION = 400;

export function FeatherLetter({ story, onClosed }: { story: Story; onClosed: () => void }) {
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
  const [imageFailed, setImageFailed] = useState(false);

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
    if (phaseRef.current !== "reading" || confirmationRef.current?.open) return;
    if (draft.trim()) {
      confirmationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setConfirming(true);
      confirmationRef.current?.showModal();
      continueRef.current?.focus({ preventScroll: true });
    } else beginClose();
  }

  function continueEditing() {
    confirmationRef.current?.close();
    setConfirming(false);
    // The previous control may be in the temporarily inert reading content.
    focusFrame.current = requestAnimationFrame(() => confirmationTrigger.current?.focus({ preventScroll: true }));
  }

  function discardAndClose() {
    confirmationRef.current?.close();
    setConfirming(false);
    beginClose();
  }

  return (
    <dialog ref={dialogRef} className="letter-dialog" data-phase={phase} data-story-id={story.id}
      aria-labelledby="letter-title" aria-describedby="letter-demo-note" aria-busy={phase !== "reading"}
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
        <button ref={closeRef} type="button" className="letter-close" aria-label="关闭羽毛信"
          disabled={phase !== "reading" || confirming} onClick={requestClose}>×</button>
        <div className="letter-scroll" tabIndex={0} aria-label="信纸阅读内容" inert={phase !== "reading" || confirming}>
          <header className="letter-heading">
            <h2 id="letter-title">{story.title}</h2>
            <p className="letter-meta"><span>{story.date}</span><span>MQ 演示书信</span></p>
            <p id="letter-demo-note" className="letter-demo-note">合成演示 · 非真实回忆</p>
          </header>
          <article className="letter-prose" aria-label={story.title}>
            <blockquote>{story.introduction}</blockquote>
            <p>{story.paragraphs[0]}</p>
            <figure className="letter-photo">
              {imageFailed ? <div className="letter-image-fallback" role="status">演示配图暂时无法显示，正文仍可继续阅读。</div> :
                <img src={story.image.src} alt={story.image.alt} width="768" height="512" onError={() => setImageFailed(true)} />}
              <figcaption>{story.image.caption}</figcaption>
            </figure>
            {story.paragraphs.slice(1).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
            <p className="letter-signature">{story.closing}</p>
          </article>
          <div className="letter-divider" aria-hidden="true" />
          <div className="letter-reactions">
            <button type="button" className="letter-like" aria-pressed={liked} onClick={() => setLiked(!liked)}>
              <span aria-hidden="true">{liked ? "♥" : "♡"}</span>演示点赞 <span>{liked ? 1 : 0}</span>
            </button>
            <span className="letter-comment-count">留言示例 1</span>
            <span className="letter-reaction-note">仅本次阅读有效，不会发送</span>
          </div>
          <section className="letter-comments" aria-labelledby="letter-comments-title">
            <h3 id="letter-comments-title">留言</h3>
            <AccountControls reader />
            <p id="letter-comment-help">写下此刻的想法。仅供演示，不会发送、公开或保存；真实留言审核功能尚未接入。</p>
            <form onSubmit={(event) => { event.preventDefault(); if (draft.trim()) setPreview(draft); }}>
              <label className="sr-only" htmlFor="letter-comment">演示留言</label>
              <textarea id="letter-comment" value={draft} rows={3} maxLength={500}
                aria-describedby="letter-comment-help" placeholder="把想说的话，写在这里……"
                onChange={(event) => { setDraft(event.target.value); setPreview(null); }} />
              <div className="letter-comment-actions">
                <span>{draft.length}/500 · 原型限制</span>
                <button type="submit" disabled={!draft.trim()}>预览留言（不发送）</button>
              </div>
            </form>
            <div className="letter-comment-preview" role="status" aria-live="polite">
              {preview !== null ? <><h4>你的演示预览 · 尚未发送</h4><p>{preview}</p><small>输入仍保留，关闭时会询问是否放弃。</small></> : null}
            </div>
            <div className="letter-sample-comment">
              <span className="letter-comment-avatar" aria-hidden="true">星</span>
              <div>
                <p><strong>演示访客</strong><span>合成留言示例</span></p>
                <p>愿每一个平凡的夜晚，都有值得收藏的微光。</p>
              </div>
            </div>
          </section>
          <p className="letter-end">这一页的故事，暂且写到这里。</p>
        </div>
      </div>
      <dialog ref={confirmationRef} className="letter-discard" role="alertdialog"
        aria-labelledby="letter-discard-title" aria-describedby="letter-discard-description"
        onCancel={(event) => { event.preventDefault(); event.stopPropagation(); continueEditing(); }}>
        <h2 id="letter-discard-title">要放下这封信吗？</h2>
        <p id="letter-discard-description">演示留言尚未提交。关闭后，这次输入和预览会被清除。</p>
        <div className="letter-discard-actions">
          <button ref={continueRef} type="button" onClick={continueEditing}>继续编辑</button>
          <button type="button" onClick={discardAndClose}>放弃并关闭</button>
        </div>
      </dialog>
    </dialog>
  );
}
