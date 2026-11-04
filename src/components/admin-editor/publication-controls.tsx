"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DraftClientError } from "../../lib/admin-editor/api";
import { publicationApi } from "../../lib/admin-editor/publication-api";
import { canPublishAction, isDirty, type EditorState } from "../../lib/admin-editor/state";
import type { PublicationAction, StarSlot } from "../../lib/admin-editor/types";
import { storySlotClasses, type StorySlotId } from "../../lib/stories/scene-catalog";

const stateNames = { DRAFT: "尚未发布", PUBLISHED: "已公开", WITHDRAWN: "已下架" };
const occupation = { DRAFT: "草稿预留", PUBLISHED: "已发布", WITHDRAWN: "下架保留" };
const slotName = (id: string) => /^star-\d+$/.test(id) ? `星位 ${id.slice(5)}` : id;

export function PublicationControls({ editor, enabled, blocked, onAction, onDenied }: {
  editor: EditorState; enabled: boolean; blocked: boolean;
  onAction: (action: PublicationAction, slotId?: string | null) => void;
  onDenied: () => void;
}) {
  const story = editor.confirmed?.story;
  const [slots, setSlots] = useState<StarSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ version: number; id: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const request = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const ownSlot = slots.find(slot => slot.story?.id === story?.id);
  const selected = choice?.version === story?.version ? choice?.id : ownSlot?.id;
  const available = enabled && loaded && !loading && !error && !blocked;
  const dirty = isDirty(editor);

  const loadSlots = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(null);
    try {
      const result = await publicationApi.slots(controller.signal);
      if (!controller.signal.aborted) { setSlots(result); setLoaded(true); }
    } catch (failure) {
      if (controller.signal.aborted) return;
      setLoaded(false);
      setError("暂时无法确认发布服务和星位状态。请重试；草稿仍可保存和预览。");
      if (failure instanceof DraftClientError && failure.kind === "denied") onDenied();
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [onDenied]);

  useEffect(() => {
    if (!enabled || blocked) return;
    // Track the real read after selecting a story or receiving a new server version.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSlots();
    return () => request.current?.abort();
  }, [enabled, blocked, story?.id, story?.version, loadSlots]);
  useEffect(() => { if (confirming) dialog.current?.showModal(); }, [confirming]);

  function closeConfirmation() { dialog.current?.close(); setConfirming(false); }
  const canChoose = available && canPublishAction(editor, "slot");
  const chosenSlot = slots.find(slot => slot.id === selected);
  const canReserve = canChoose && chosenSlot && !chosenSlot.story && selected !== ownSlot?.id;
  const canPublish = available && canPublishAction(editor, "publish")
    && (editor.working.kind === "CAMPFIRE" || Boolean(ownSlot));

  return <section className="editor-publication" aria-label="发布管理">
    <div className="publication-heading"><div><h2>发布管理</h2>
      <p data-testid="publication-status" data-state={story?.state ?? "unsaved"}
        data-version={story?.version ?? ""} data-operation={editor.publication?.action ?? ""}>
        <span className={`publication-badge is-${story?.state.toLowerCase() ?? "draft"}`}>{story ? stateNames[story.state] : "新手稿"}</span>
        <span>{story ? `服务器版本 ${story.version}` : "尚未保存到服务器"}</span>
      </p></div>
      {story?.state === "PUBLISHED" ? <a href={`/stories/${story.slug}`} target="_blank" rel="noopener noreferrer">查看公开版本 ↗</a> : null}
    </div>
    <p className="publication-summary">{!story ? "请先保存当前草稿，再选择入口并发布。"
      : story.state === "DRAFT" ? "已保存的草稿尚未公开。发布后，访客才能从故事入口或分享链接阅读。"
        : story.hasUnpublishedChanges ? "服务器有未发布的草稿修改。当前公开内容仍保持原样。"
          : story.state === "WITHDRAWN" ? "公开访问已停止，原公开版本和入口仍保留。" : "当前已保存内容与公开版本一致。"}</p>
    {dirty ? <p className="publication-local-note">本地还有未保存修改。请先保存，再发布这些修改。</p> : null}
    {!enabled ? <p className="publication-unavailable">发布管理尚未启用。你仍可以保存草稿和预览羽毛信。</p>
      : <>
        {loading ? <p className="publication-read-state" role="status">正在核对星位与发布服务…</p> : null}
        {error ? <p className="publication-read-state" role="alert">{error}</p> : null}
        <div className="publication-entry-heading"><h3>{editor.working.kind === "STAR" ? "故事星位" : "篝火入口"}</h3>
          <button type="button" className="editor-text-button" disabled={loading || blocked || Boolean(editor.publication)} onClick={() => void loadSlots()}>刷新星位</button></div>
        {editor.working.kind === "CAMPFIRE" ? <p className="publication-campfire">这篇故事使用唯一的篝火入口，不占用普通星位。</p>
          : <div className="publication-slots">
            <div className="publication-slot-map" aria-hidden="true"><span className="publication-map-logo">MQ</span>
              {slots.map(slot => { const position = storySlotClasses[slot.id as StorySlotId];
                return position ? <span key={slot.id} className={`publication-map-point story-position ${position} ${slot.story ? "is-occupied" : "is-free"} ${slot.id === ownSlot?.id ? "is-own" : ""}`}>
                  <span>✧</span><small>{slot.id.replace("star-", "")}</small></span> : null;
              })}<span className="publication-map-caption">预设星位示意</span></div>
            <div><fieldset className="publication-slot-options" disabled={!canChoose}><legend className="editor-sr-only">选择故事星位</legend>
              {slots.map(slot => <label key={slot.id} className={`publication-slot-option ${slot.id === selected ? "is-selected" : ""}`}>
                <input type="radio" name="story-slot" aria-label={slotName(slot.id)} value={slot.id} checked={selected === slot.id}
                  disabled={Boolean(slot.story && slot.story.id !== story?.id)}
                  onChange={() => story && setChoice({ version: story.version, id: slot.id })} />
                <span>{slotName(slot.id)}<small>{slot.story ? `${slot.story.id === story?.id ? "本篇 · " : ""}${occupation[slot.story.state]}` : "空闲"}</small></span>
              </label>)}
            </fieldset>
            {story?.state === "DRAFT" ? <button type="button" className="publication-reserve" disabled={!canReserve}
              onClick={() => onAction("slot", selected)}>确认星位</button> : null}
            {story && story.state !== "DRAFT" ? <p className="publication-slot-note">已有入口保持稳定，下架不会释放星位。</p> : null}
            {!loading && loaded && !slots.length ? <p>暂无可用的预设星位。</p> : null}
            </div>
          </div>}
        <div className="publication-actions">
          {story?.state !== "WITHDRAWN" ? <button type="button" className="editor-primary" disabled={!canPublish}
            onClick={() => onAction("publish")}>{story?.state === "PUBLISHED" ? "发布更新" : "发布故事"}</button> : null}
          {story?.state === "PUBLISHED" ? <button type="button" className="publication-withdraw" disabled={!available || !canPublishAction(editor, "withdraw")}
            onClick={() => setConfirming(true)}>下架故事</button> : null}
          {story?.state === "WITHDRAWN" ? <button type="button" className="editor-primary" disabled={!available || !canPublishAction(editor, "restore")}
            onClick={() => onAction("restore")}>恢复原公开版本</button> : null}
          <p>{editor.publication ? "正在处理，请等待结果；不会自动重复提交。"
            : story?.state === "WITHDRAWN" ? "恢复只开放下架前的公开版本，不会发布后来编辑的新草稿。"
              : "保存只更新私有草稿；发布才会对访客可见。"}</p>
        </div>
      </>}
    <dialog ref={dialog} className="editor-leave-dialog publication-confirm" aria-labelledby="publication-confirm-title"
      onCancel={event => { event.preventDefault(); closeConfirmation(); }}>
      <h2 id="publication-confirm-title">确认下架这篇故事？</h2><p>新的公开请求将无法读取这篇故事。星位和原公开版本会保留，可以稍后恢复。本地编辑不会丢失。</p>
      <div><button type="button" autoFocus onClick={closeConfirmation}>取消</button><button type="button" className="publication-withdraw"
        onClick={() => { closeConfirmation(); onAction("withdraw"); }}>确认下架</button></div>
    </dialog>
  </section>;
}
