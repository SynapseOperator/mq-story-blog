"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mediaApi, MediaClientError, uploadMediaFile, type MediaAsset } from "../../lib/admin-editor/media-api";

export type MediaTarget = { instanceId: string; blockKey: string | null; requestId: string };
type Upload = { id: string | null; phase: "idle" | "uploading" | "processing" | "uncertain" | "failed" | "ready";
  progress: number; message: string };
const emptyUpload: Upload = { id: null, phase: "idle", progress: 0, message: "" };
const stateName = { PENDING: "处理中", READY: "可选择", FAILED: "处理失败", DELETING: "正在移除", DELETED: "已移除" };

/** Kept mounted when closed so an unknown upload retains its original UUID.
 * Neither selecting nor uploading writes a story or changes its save snapshot. */
export function MediaPicker({ target, onClose, onChoose, onDenied }: {
  target: MediaTarget | null; onClose: () => void;
  onChoose: (asset: MediaAsset, target: MediaTarget) => void; onDenied: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const listRequest = useRef<AbortController | null>(null);
  const uploadId = useRef<string | null>(null);
  const backdropPress = useRef(false);
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [upload, setUpload] = useState<Upload>(emptyUpload);
  const open = target !== null;
  const unresolved = ["uploading", "processing", "uncertain"].includes(upload.phase);

  const handleError = useCallback((error: unknown) => {
    const known = error instanceof MediaClientError ? error : new MediaClientError("unavailable");
    if (known.kind === "denied") onDenied();
    return known;
  }, [onDenied]);
  const load = useCallback(async (after: string | null = null) => {
    listRequest.current?.abort();
    const request = new AbortController(); listRequest.current = request;
    setLoading(true); setError(null);
    try {
      const page = await mediaApi.list(after, request.signal);
      if (!mounted.current || request.signal.aborted) return;
      setItems(current => after ? [...current, ...page.items.filter(item => !current.some(old => old.id === item.id))] : page.items);
      setCursor(page.nextCursor);
    } catch (error) {
      if (mounted.current && !request.signal.aborted) setError(handleError(error).message);
    } finally { if (mounted.current && !request.signal.aborted) setLoading(false); }
  }, [handleError]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; listRequest.current?.abort(); }; }, []);
  useEffect(() => {
    if (!open) { dialog.current?.close(); listRequest.current?.abort(); return; }
    const element = dialog.current;
    const scroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    // Private API request lifecycle; no story mutation or content persistence.
    void load();
    return () => { element?.close(); document.body.style.overflow = scroll; };
  }, [open, load]);
  useEffect(() => {
    if (!unresolved) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [unresolved]);

  function rememberAsset(asset: MediaAsset) {
    setItems(current => [asset, ...current.filter(item => item.id !== asset.id)]);
    if (asset.state === "READY") setSelected(asset.id);
  }
  async function uploadFile(file: File) {
    if (unresolved) return;
    const id = crypto.randomUUID(); uploadId.current = id;
    setSending(true);
    setUpload({ id, phase: "uploading", progress: 0, message: "正在上传图片…" }); setError(null);
    try {
      const asset = await uploadMediaFile(file, id,
        progress => { if (mounted.current && uploadId.current === id) setUpload(current => ({ ...current, progress })); },
        () => { if (mounted.current && uploadId.current === id) setUpload(current => ({ ...current, phase: "processing", progress: 100, message: "上传完成，正在校验并处理图片…" })); });
      if (!mounted.current || uploadId.current !== id) return;
      rememberAsset(asset);
      setUpload({ id, phase: "ready", progress: 100, message: "图片已存入私有素材库。请确认插入，故事尚未保存。" });
    } catch (error) {
      if (!mounted.current || uploadId.current !== id) return;
      const known = handleError(error);
      setUpload(current => ({ ...current, phase: ["uncertain", "denied"].includes(known.kind) ? "uncertain" : "failed", message: known.message }));
    } finally { if (mounted.current && uploadId.current === id) setSending(false); }
  }
  async function checkUpload() {
    if (!upload.id || checking || sending) return;
    const id = upload.id; setChecking(true);
    try {
      const asset = await mediaApi.get(id);
      if (!mounted.current || uploadId.current !== id) return;
      rememberAsset(asset);
      setUpload(current => ({ ...current, phase: asset.state === "READY" ? "ready" : asset.state === "PENDING" ? "processing" : "failed",
        message: asset.state === "READY" ? "已确认图片处理完成。请确认插入，故事尚未保存。"
          : asset.state === "PENDING" ? "图片仍在处理中，请稍后再次检查；不会重复上传。" : "已确认本次图片不可用。可以重新选择文件上传。" }));
    } catch (error) {
      if (mounted.current && uploadId.current === id) setUpload(current => ({ ...current, phase: "uncertain", message: handleError(error).message }));
    } finally { if (mounted.current) setChecking(false); }
  }
  async function choose() {
    if (!selected || !target || confirming) return;
    const destination = target; setConfirming(true); setError(null);
    try {
      // Recheck current authorization and readiness; a stale grid is not access.
      const asset = await mediaApi.get(selected);
      if (!mounted.current) return;
      if (asset.state !== "READY") { setError("这张图片尚不可用，请选择处理完成的素材。"); return; }
      onChoose(asset, destination);
    } catch (error) { if (mounted.current) setError(handleError(error).message); }
    finally { if (mounted.current) setConfirming(false); }
  }
  const chosen = items.find(item => item.id === selected && item.state === "READY");
  return <dialog ref={dialog} className="editor-media-dialog" aria-label="选择故事图片"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { backdropPress.current = event.target === event.currentTarget; }}
    onClick={event => { if (event.target === event.currentTarget && backdropPress.current) onClose(); backdropPress.current = false; }}>
    <div className="editor-media-shell">
      <header className="editor-media-heading"><div><h2>为故事添一张照片</h2><p>上传只存入私有素材库；插入后，仍需手动保存故事。</p></div>
        <button type="button" aria-label="关闭素材选择" onClick={onClose}>×</button></header>
      <div className="editor-media-scroll">
        <section className="editor-media-upload" aria-label="上传图片">
          <label className={`editor-media-file ${unresolved ? "is-disabled" : ""}`}>选择图片上传
            <input type="file" aria-label="选择要上传的图片" accept="image/jpeg,image/png,image/webp" disabled={unresolved}
              onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void uploadFile(file); }} /></label>
          <p>JPEG、PNG 或静态 WebP · 最大 3 MiB / 2400 万像素。<br />系统不保留原图，请自行备份。</p>
          {upload.phase !== "idle" ? <div className="editor-media-upload-state" data-testid="media-upload-status" data-state={upload.phase} role="status">
            <p>{upload.phase === "uploading" ? `正在上传 ${upload.progress}%` : upload.message}</p>
            {upload.phase === "uploading" ? <progress max={100} value={upload.progress} aria-label="图片上传进度" /> : null}
            {["processing", "uncertain"].includes(upload.phase) ? <button type="button" disabled={checking || sending} onClick={() => void checkUpload()}>{checking ? "正在检查…" : "核对这次上传的状态"}</button> : null}
          </div> : null}
        </section>
        <div className="editor-media-library-heading"><h3>私有素材库</h3><button type="button" disabled={loading} onClick={() => void load()}>刷新素材</button></div>
        {error ? <p className="editor-media-error" role="alert">{error}</p> : null}
        {loading ? <p className="editor-media-note" role="status">正在读取素材…</p> : null}
        {!loading && !items.length && !error ? <p className="editor-media-empty">还没有素材。先上传一张图片，再把它放进故事。</p> : null}
        <div className="editor-media-grid">{items.map(asset => <button type="button" key={asset.id}
          className={`editor-media-item ${selected === asset.id ? "is-selected" : ""}`} aria-label={`选择图片 ${asset.id}`}
          aria-pressed={selected === asset.id} disabled={asset.state !== "READY"} onClick={() => setSelected(asset.id)}>
          {asset.state === "READY" ? <img src={`/api/admin/media/${asset.id}/content?variant=thumbnail`} width={400} height={300}
            alt="素材缩略图" loading="lazy" decoding="async" referrerPolicy="no-referrer" /> : <span className="editor-media-placeholder">{stateName[asset.state]}</span>}
          <span className="editor-media-dimensions">{asset.display ? `${asset.display.width} × ${asset.display.height} · ${(asset.display.byteLength / 1024).toFixed(0)} KiB` : stateName[asset.state]}</span>
          <span className="editor-media-usage">{asset.publishedStoryCount ? `当前用于 ${asset.publishedStoryCount} 篇公开故事` : "尚未用于公开故事"}</span>
        </button>)}</div>
        {cursor ? <button className="editor-media-more" type="button" disabled={loading} onClick={() => void load(cursor)}>更多素材</button> : null}
      </div>
      <footer className="editor-media-footer"><p>{chosen ? "已选中一张图片。它可以被多篇故事显式复用。" : "选择一张处理完成的图片。"}</p>
        <button type="button" className="editor-media-insert" disabled={!chosen || confirming} onClick={() => void choose()}>{confirming ? "正在确认…" : target?.blockKey ? "替换图片" : "插入图片"}</button></footer>
    </div>
  </dialog>;
}
