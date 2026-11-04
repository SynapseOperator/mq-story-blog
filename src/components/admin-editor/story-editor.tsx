"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { draftApi, DraftClientError } from "../../lib/admin-editor/api";
import { canSave, createEditor, editorReducer, imageBlock, isDirty, needsLeaveProtection, openEditor, paragraphBlock,
  validateDocument, type EditorAction, type EditorState } from "../../lib/admin-editor/state";
import type { DraftSummary, EditorBlock, EditorDocument, StoryKind } from "../../lib/admin-editor/types";
import { createPreviewSnapshot } from "../../lib/admin-editor/preview";
import type { LetterPreviewSnapshot } from "../../lib/stories/story";
import { FeatherLetter } from "../reader/feather-letter";
import { Landscape } from "../scene/landscape";
import { MediaPicker, type MediaTarget } from "./media-picker";
import type { MediaAsset } from "../../lib/admin-editor/media-api";
import "../reader/letter.css";

type ReturnPoint = { element: HTMLElement; start: number | null; end: number | null;
  direction: "forward" | "backward" | "none" | null; scroll: number; scrollLeft: number; x: number; y: number };
const kindName = { STAR: "星空故事", CAMPFIRE: "篝火故事" };
const stateName = { DRAFT: "未发布", PUBLISHED: "已发布 · 编辑草稿", WITHDRAWN: "已下架" };

function setAddress(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("story", id); else url.searchParams.delete("story");
  window.history.replaceState(window.history.state, "", url);
}

export function StoryEditor({ initialId }: { initialId: string | null }) {
  const [editor, setEditor] = useState<EditorState | null>(null);
  const current = useRef<EditorState | null>(null);
  const [items, setItems] = useState<DraftSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [accessLost, setAccessLost] = useState(false);
  const [previewSnapshot, setPreviewSnapshot] = useState<LetterPreviewSnapshot | null>(null);
  const [mediaTarget, setMediaTarget] = useState<MediaTarget | null>(null);
  const mediaTargetRef = useRef<MediaTarget | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const detailGeneration = useRef(0);
  const editGeneration = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const pendingNavigation = useRef<(() => void) | null>(null);
  const returnPoint = useRef<ReturnPoint | null>(null);
  const mounted = useRef(false);

  const restoreReturnPoint = useCallback(() => {
    const point = returnPoint.current;
    requestAnimationFrame(() => {
      if (!point?.element.isConnected) return;
      const active = document.activeElement;
      // A new editing action takes precedence over the queued dialog return.
      if (active !== point.element && (active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement)) return;
      point.element.focus({ preventScroll: true });
      if (point.start !== null && (point.element instanceof HTMLInputElement || point.element instanceof HTMLTextAreaElement)) {
        point.element.setSelectionRange(point.start, point.end, point.direction ?? undefined);
      }
      point.element.scrollTop = point.scroll; point.element.scrollLeft = point.scrollLeft;
      window.scrollTo(point.x, point.y);
    });
  }, []);
  // Stable across a save ACK: it must not restart the mounted reader's effect.
  const closePreview = useCallback(() => { setPreviewSnapshot(null); restoreReturnPoint(); }, [restoreReturnPoint]);
  const closeMedia = useCallback(() => { mediaTargetRef.current = null; setMediaTarget(null); restoreReturnPoint(); }, [restoreReturnPoint]);

  const commit = useCallback((next: EditorState | null) => { current.current = next; setEditor(next); }, []);
  const dispatch = useCallback((action: EditorAction) => {
    if (current.current) commit(editorReducer(current.current, action));
  }, [commit]);
  const deny = useCallback(() => {
    listRequest.current?.abort(); detailRequest.current?.abort(); ++detailGeneration.current;
    setListBusy(false); setDetailBusy(false);
    setAccessLost(true); setItems([]); setCursor(null);
    mediaTargetRef.current = null; setMediaTarget(null);
    dispatch({ type: "access-denied" });
  }, [dispatch]);
  const failure = useCallback((error: unknown) => {
    const known = error instanceof DraftClientError ? error : new DraftClientError("retryable");
    if (known.kind === "denied") deny();
    return known;
  }, [deny]);

  const loadList = useCallback(async (after: string | null = null) => {
    listRequest.current?.abort();
    const request = new AbortController(); listRequest.current = request;
    setListBusy(true); setListError(null);
    try {
      const result = await draftApi.list(after, request.signal);
      if (request.signal.aborted || !mounted.current) return;
      setItems(old => after ? [...old, ...result.items.filter(row => !old.some(item => item.id === row.id))] : result.items);
      setCursor(result.nextCursor);
    } catch (error) {
      if (!request.signal.aborted && mounted.current) setListError(failure(error).message);
    } finally { if (!request.signal.aborted && mounted.current) setListBusy(false); }
  }, [failure]);

  const loadDetail = useCallback(async (id: string, reconcile = false) => {
    detailRequest.current?.abort();
    const request = new AbortController(); detailRequest.current = request;
    const generation = ++detailGeneration.current;
    const instanceId = current.current?.instanceId;
    const editsAtStart = editGeneration.current;
    setDetailBusy(true); setNotice(null);
    try {
      const result = await draftApi.get(id, request.signal);
      if (request.signal.aborted || !mounted.current || generation !== detailGeneration.current) return;
      if (reconcile) {
        if (current.current?.instanceId !== instanceId) return;
        dispatch({ type: "remote-read", detail: result });
      } else {
        if (editGeneration.current !== editsAtStart || current.current?.pending) {
          setNotice("读取期间本地内容已变化，已取消切换。你的编辑仍然保留。"); return;
        }
        commit(openEditor(result)); setAddress(id); setListOpen(false);
      }
    } catch (error) {
      if (!request.signal.aborted && mounted.current) setNotice(failure(error).message);
    } finally { if (!request.signal.aborted && mounted.current) setDetailBusy(false); }
  }, [commit, dispatch, failure]);

  // Only the initial route selects a document. replaceState below stores its ID,
  // not a new navigation or any draft body, and must not reinitialize working text.
  const [initial] = useState(initialId);
  useEffect(() => {
    mounted.current = true;
    // Private data starts loading after hydration; these setters track real API requests.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadList();
    if (initial) void loadDetail(initial);
    const recheck = (event: PageTransitionEvent) => { if (event.persisted) void loadList(); };
    window.addEventListener("pageshow", recheck);
    return () => { mounted.current = false; listRequest.current?.abort(); detailRequest.current?.abort(); window.removeEventListener("pageshow", recheck); };
  }, [loadList, loadDetail, initial]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (current.current && needsLeaveProtection(current.current)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  useEffect(() => { if (leaving && !dialog.current?.open) dialog.current?.showModal(); }, [leaving]);

  function remember(element: HTMLElement) {
    const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
    returnPoint.current = { element, start: input?.selectionStart ?? null, end: input?.selectionEnd ?? null,
      direction: input?.selectionDirection ?? null, scroll: element.scrollTop, scrollLeft: element.scrollLeft,
      x: window.scrollX, y: window.scrollY };
  }
  function cancelLeave() {
    dialog.current?.close(); setLeaving(false); pendingNavigation.current = null;
    restoreReturnPoint();
  }
  function openPreview(trigger: HTMLButtonElement) {
    if (!current.current || accessLost || leaving || detailBusy || previewSnapshot) return;
    if (!returnPoint.current?.element.isConnected) remember(trigger);
    const point = returnPoint.current!;
    // Keep the text selection, but capture the view at this opening, not an old blur.
    returnPoint.current = { ...point, scroll: point.element.scrollTop, scrollLeft: point.element.scrollLeft,
      x: window.scrollX, y: window.scrollY };
    // A separate, immutable local view; no reducer action, validation or API call.
    setPreviewSnapshot(createPreviewSnapshot(current.current.working, isDirty(current.current) || !current.current.confirmed));
  }
  function openMedia(trigger: HTMLButtonElement, blockKey: string | null = null) {
    if (!current.current || accessLost || leaving || detailBusy || previewSnapshot) return;
    if (!returnPoint.current?.element.isConnected) remember(trigger);
    const target = { instanceId: current.current.instanceId, blockKey, requestId: crypto.randomUUID() };
    mediaTargetRef.current = target; setMediaTarget(target);
  }
  function insertMedia(asset: MediaAsset, destination: MediaTarget) {
    if (asset.state !== "READY" || accessLost || destination !== mediaTargetRef.current
      || current.current?.instanceId !== destination.instanceId) return;
    ++editGeneration.current;
    dispatch({ type: "select-media", instanceId: destination.instanceId, blockKey: destination.blockKey,
      assetId: asset.id, newBlockKey: crypto.randomUUID() });
    closeMedia();
  }
  function navigate(action: () => void) {
    if (current.current?.pending) { setNotice("保存正在进行，请等待结果后再切换故事。"); return; }
    if (current.current && needsLeaveProtection(current.current)) { pendingNavigation.current = action; setLeaving(true); }
    else action();
  }
  function newStory(kind: StoryKind) {
    navigate(() => { detailRequest.current?.abort(); ++detailGeneration.current; setDetailBusy(false);
      commit(createEditor(kind)); setAddress(null); setNotice(null); setListOpen(false); });
  }
  function edit(change: (document: EditorDocument) => EditorDocument) {
    ++editGeneration.current;
    if (current.current) dispatch({ type: "edit", document: change(current.current.working) });
  }
  function changeBlock(key: string, change: (block: EditorBlock) => EditorBlock) {
    edit(document => ({ ...document, blocks: document.blocks.map(block => block.key === key ? change(block) : block) }));
  }
  function moveBlock(index: number, step: number) {
    edit(document => { const blocks = [...document.blocks]; [blocks[index], blocks[index + step]] = [blocks[index + step], blocks[index]]; return { ...document, blocks }; });
  }
  async function save() {
    if (!current.current || accessLost || detailBusy || !canSave(current.current)) return;
    dispatch({ type: "begin-save", requestId: crypto.randomUUID() });
    const attempt = current.current.pending;
    if (!attempt) return;
    setNotice(null);
    try {
      const story = attempt.storyId
        ? await draftApi.save(attempt.storyId, attempt.expectedVersion!, attempt.document)
        : await draftApi.create(attempt.document);
      if (!mounted.current || current.current?.instanceId !== attempt.instanceId) return;
      dispatch({ type: "save-ok", requestId: attempt.requestId, story });
      if (current.current.confirmed) setAddress(current.current.confirmed.story.id);
      void loadList();
    } catch (error) {
      if (!mounted.current || current.current?.instanceId !== attempt.instanceId) return;
      const known = failure(error);
      dispatch({ type: "save-error", requestId: attempt.requestId, kind: known.kind, message: known.message });
    }
  }
  function resolveRemote(type: "keep-local" | "use-remote") {
    dispatch({ type });
    if (current.current?.confirmed) setAddress(current.current.confirmed.story.id);
    setListOpen(false);
  }

  const dirty = editor ? isDirty(editor) : false;
  const unknownCreate = Boolean(editor && !editor.confirmed && ["uncertain", "conflict"].includes(editor.status));
  const status = accessLost || editor?.status === "denied" ? "blocked" : editor?.status === "saving" ? "saving"
    : editor?.status === "conflict" ? "conflict" : editor?.status === "uncertain" ? "uncertain"
      : editor?.error ? "error" : dirty ? "dirty" : "saved";
  const statusText = { blocked: "权限失效 · 本地内容保留", saving: "正在保存发送快照…", conflict: "版本冲突 · 请人工核对",
    uncertain: "保存结果未知 · 请先核对", error: "未能保存 · 内容保留", dirty: "有未保存的修改", saved: editor?.confirmed ? `已保存 · 版本 ${editor.confirmed.story.version}` : "尚未创建" }[status];
  const invalid = editor ? validateDocument(editor.working) : null;

  return <><main className="editor-workspace" data-testid="story-editor">
    <header className="editor-topbar"><a className="editor-home" aria-label="返回 MQ" href="/" onClick={event => { event.preventDefault(); navigate(() => window.location.assign("/")); }}><span className="editor-brand">MQ</span><span>返回 MQ</span></a>
      <span className="editor-private">私有工作区 <span aria-hidden="true">·</span> 仅管理员</span></header>
    <div className="editor-heading"><div><p className="editor-eyebrow">OUR STORIES / MANUSCRIPTS</p><h1>把回忆写下来</h1><p>慢慢写，手动保存。这里的修改不会自动发布。</p></div><span className="editor-chapter" aria-hidden="true">手 稿</span></div>
    <div className="editor-columns">
      <aside className={`editor-library ${listOpen ? "is-open" : ""}`} aria-label="草稿列表">
        <div className="editor-library-title"><h2>故事手稿 <span>{items.length}{cursor ? "+" : ""}</span></h2><button className="editor-mobile-toggle" onClick={() => setListOpen(!listOpen)} aria-expanded={listOpen}>{listOpen ? "收起目录" : "展开目录"}</button></div>
        <div className="editor-library-body"><div className="editor-create"><button disabled={accessLost || Boolean(editor?.pending) || (unknownCreate && editor?.status === "uncertain")} onClick={() => newStory("STAR")}>新建故事 <span aria-hidden="true">＋</span></button><button disabled={accessLost || Boolean(editor?.pending) || (unknownCreate && editor?.status === "uncertain")} onClick={() => newStory("CAMPFIRE")}>新建篝火</button></div>
          <button className="editor-text-button" disabled={listBusy || accessLost} onClick={() => void loadList()}>刷新草稿列表</button>
          {listError && <p role="alert" className="editor-library-error">{listError}</p>}
          {listBusy && <p role="status" className="editor-muted">正在读取手稿…</p>}
          {!listBusy && !listError && !items.length && <p className="editor-empty-list">还没有手稿。<br />从一个小小的片刻开始。</p>}
          <ul>{items.map(item => <li key={item.id} data-testid="draft-row" data-story-id={item.id}>
            <button className={`editor-draft-link ${editor?.confirmed?.story.id === item.id ? "is-selected" : ""}`} disabled={accessLost || Boolean(editor?.pending) || detailBusy}
              aria-label={unknownCreate ? "核对这篇草稿" : undefined}
              aria-current={editor?.confirmed?.story.id === item.id ? "true" : undefined}
              onClick={() => unknownCreate ? void loadDetail(item.id, true) : navigate(() => void loadDetail(item.id))}>
              <span className="editor-draft-kind">{kindName[item.kind]} <span>{stateName[item.state]}</span></span><strong>{item.draftTitle}</strong>
              <span className="editor-draft-meta">版本 {item.version} · {new Date(item.updatedAt).toLocaleDateString("zh-CN")}</span>
              {unknownCreate && <span className="editor-reconcile-label">核对这篇草稿</span>}
            </button>
          </li>)}</ul>
          {cursor && <button className="editor-more" disabled={listBusy || accessLost} onClick={() => void loadList(cursor)}>更多草稿</button>}
        </div>
      </aside>
      <section className="editor-writing" aria-label="故事编辑">
        {notice && <p role="alert" className="editor-feedback">{notice}</p>}
        {detailBusy && <p role="status" className="editor-feedback">正在读取服务器草稿…</p>}
        {!editor ? <div className="editor-welcome"><span aria-hidden="true">✧</span><p className="editor-eyebrow">A PLACE FOR MEMORIES</p><h2>每一篇故事，都从这里开始</h2><p>选择一份手稿继续写，或新建一篇故事。<br />只有明确保存的内容才会留在服务器。</p><button className="editor-primary" disabled={accessLost || detailBusy} onClick={() => newStory("STAR")}>开始写故事</button>{initial && notice && <button onClick={() => void loadDetail(initial!)}>重试读取草稿</button>}</div>
          : <>
            <div className="editor-savebar"><div><span className="editor-eyebrow">{kindName[editor.working.kind]} / {editor.confirmed ? stateName[editor.confirmed.story.state] : "新手稿"}</span><p data-testid="editor-status" data-state={status} role="status"><i aria-hidden="true" />{statusText}</p></div><div className="editor-save-actions"><button type="button" disabled={accessLost || detailBusy || leaving}
              onPointerDown={() => {
                const active = document.activeElement;
                if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) remember(active);
              }} onClick={event => openPreview(event.currentTarget)}>预览羽毛信</button>
              <button className="editor-primary" disabled={accessLost || detailBusy || !canSave(editor)} onClick={() => void save()}>保存草稿</button></div></div>
            {editor.error && <p className="editor-feedback" role="alert">{editor.error}</p>}
            {["uncertain", "conflict"].includes(editor.status) && <div className="editor-recovery"><h2>先核对，再决定</h2><p>本地修改完整保留。不会自动重复提交或覆盖服务器版本。</p>
              {editor.confirmed ? <button disabled={detailBusy || accessLost} onClick={() => void loadDetail(editor.confirmed!.story.id, true)}>读取服务器版本</button>
                : <><p>新建请求可能已经完成。请刷新左侧列表，人工核对候选手稿后绑定；不要重复新建。</p><button onClick={() => { setListOpen(true); void loadList(); }} disabled={listBusy || accessLost}>核对服务器草稿列表</button></>}
              {editor.lastSent && <details><summary>查看最近一次发送的内容</summary><p>{editor.lastSent.document.title}</p>{editor.lastSent.document.blocks.map(block => <p key={block.key}>{block.type === "paragraph" ? block.text : `图片：${block.alt}`}</p>)}</details>}
            </div>}
            {editor.remote && <div className="editor-remote"><h2>服务器版本 {editor.remote.story.version}</h2><p className="editor-muted">请核对内容与故事身份。保留本地只会更新下次保存所用的版本号，不会立即写入。</p><strong>{editor.remote.draft.title}</strong><code>{editor.remote.story.slug}</code><div className="editor-remote-body">{editor.remote.draft.content.blocks.map((block, index) => <p key={index}>{block.type === "paragraph" ? block.text : `图片：${block.alt}${block.caption ? ` · ${block.caption}` : ""}`}</p>)}</div><div className="editor-remote-actions"><button disabled={accessLost} onClick={() => resolveRemote("keep-local")}>保留本地并继续编辑</button><button disabled={accessLost} onClick={() => resolveRemote("use-remote")}>载入服务器版本</button></div></div>}
            <div className="editor-paper" onBlurCapture={event => { if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) remember(event.target); }}>
              <label className="editor-title-field">故事标题<input maxLength={160} value={editor.working.title} onChange={event => edit(document => ({ ...document, title: event.target.value }))} placeholder="给这段回忆起个名字" autoComplete="off" /></label>
              <p className="editor-paper-note">{editor.confirmed ? "保存会创建新的草稿版本，公开内容保持不变。" : "创建时生成稳定地址；当前不选择星位，也不发布。"}</p>
              <div className="editor-blocks">{editor.working.blocks.map((block, index) => <section key={block.key} className={`editor-block editor-block-${block.type}`} data-testid="content-block">
                <div className="editor-block-toolbar"><span>{String(index + 1).padStart(2, "0")} / {block.type === "paragraph" ? "段落" : "图片"}</span><div><button aria-label="上移" title="上移" disabled={index === 0} onClick={() => moveBlock(index, -1)}>↑</button><button aria-label="下移" title="下移" disabled={index === editor.working.blocks.length - 1} onClick={() => moveBlock(index, 1)}>↓</button><button onClick={() => edit(document => ({ ...document, blocks: document.blocks.filter(item => item.key !== block.key) }))}>删除</button></div></div>
                {block.type === "paragraph" ? <><label className="editor-style-label">段落样式<select aria-label="段落样式" value={block.style ?? "normal"} onChange={event => changeBlock(block.key, value => value.type === "paragraph" ? { ...value, style: event.target.value as "normal" | "emphasis" | "strong" } : value)}><option value="normal">普通</option><option value="emphasis">强调</option><option value="strong">加粗</option></select></label><label className="editor-paragraph-label"><span className="editor-sr-only">段落内容</span><textarea aria-label="段落内容" className={`editor-paragraph is-${block.style ?? "normal"}`} rows={4} maxLength={10000} value={block.text} onChange={event => changeBlock(block.key, value => value.type === "paragraph" ? { ...value, text: event.target.value } : value)} placeholder="写下这一刻的故事…" /></label></>
                  : <div className="editor-image-block"><Image src={"assetId" in block ? `/api/admin/media/${block.assetId}/content` : block.src}
                    width={720} height={480} alt={block.alt || "故事配图"} unoptimized referrerPolicy="no-referrer" />
                    <div className="editor-image-actions"><p className="editor-image-note">{"assetId" in block ? "私有素材引用 · 保存不会发布" : "旧合成配图 · 可从素材库明确替换"}</p>
                      <button type="button" disabled={accessLost || detailBusy} onClick={event => openMedia(event.currentTarget, block.key)}>替换图片</button></div>
                    <label>图片说明（供无障碍阅读）<input value={block.alt} maxLength={300} onChange={event => changeBlock(block.key, value => value.type === "image" ? { ...value, alt: event.target.value } : value)} /></label><label>图片题注<input value={block.caption ?? ""} maxLength={1000} onChange={event => changeBlock(block.key, value => value.type === "image" ? { ...value, caption: event.target.value } : value)} placeholder="可选的简短说明" /></label></div>}
              </section>)}</div>
              <div className="editor-add-block"><button disabled={editor.working.blocks.length >= 200} onClick={() => edit(document => ({ ...document, blocks: [...document.blocks, paragraphBlock(crypto.randomUUID())] }))}>添加段落 <span aria-hidden="true">＋</span></button>
                <button disabled={accessLost || detailBusy || editor.working.blocks.length >= 200} onClick={event => openMedia(event.currentTarget)}>上传或选择图片</button></div>
              <div className="editor-legacy-images"><button disabled={editor.working.blocks.length >= 200} onClick={() => edit(document => ({ ...document, blocks: [...document.blocks, imageBlock(crypto.randomUUID())] }))}>添加图片</button>
                <span>旧版合成配图；加入素材图片后，需逐一替换旧图才能保存。</span></div>
              {invalid && dirty && <p className="editor-validation">{invalid}</p>}
              <p className="editor-footnote">手动保存 · 不自动发布 · 未保存内容仅保留在当前页面</p>
            </div>
          </>}
      </section>
    </div>
    <dialog className="editor-leave-dialog" ref={dialog} aria-labelledby="editor-leave-title" onCancel={event => { event.preventDefault(); cancelLeave(); }}><p className="editor-eyebrow">LEAVE MANUSCRIPT?</p><h2 id="editor-leave-title">还有内容没有确认保存</h2><p>离开会丢弃本地编辑。结果未知的请求可能已在服务器完成，离开不会撤销它。</p><div><button className="editor-primary" onClick={cancelLeave}>继续编辑</button><button onClick={() => { const action = pendingNavigation.current; pendingNavigation.current = null; dialog.current?.close(); setLeaving(false); commit(null); action?.(); }}>放弃并离开</button></div></dialog>
  </main>
    <MediaPicker target={mediaTarget} onClose={closeMedia} onChoose={insertMedia} onDenied={deny} />
    {previewSnapshot ? <>
      <div className="editor-preview-scene" aria-hidden="true"><Landscape stories={[]} reading /></div>
      <FeatherLetter mode="private-preview" snapshot={previewSnapshot} onClosed={closePreview} />
    </> : null}
  </>;
}
