"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/auth-provider";
import { draftApi, DraftClientError } from "../../lib/admin-editor/api";
import type { DraftSummary } from "../../lib/admin-editor/types";
import { commentAdminApi, CommentAdminClientError, type AdminComment, type CommentState, type ModerationAction } from "../../lib/admin-comments/api";

const stateName: Record<CommentState, string> = { PENDING: "待审核", APPROVED: "已通过", REJECTED: "已拒绝", WITHDRAWN: "已撤回" };
const storyStateName = { DRAFT: "未发布", PUBLISHED: "已发布", WITHDRAWN: "已下架" };
const actionName = { approve: "通过", reject: "拒绝", withdraw: "撤回" };
type Row = { comment: AdminComment; needsCheck?: boolean; message?: string; sent?: { action: ModerationAction; version: number } };

export function CommentModerationWorkspace({ enabled }: { enabled: boolean }) {
  const { session, status } = useAuth();
  if (status !== "authenticated" || !session) return <main className="comments-gate">
    <span className="comments-brand">MQ</span><h1>留言审核</h1>
    <p role="status">{status === "loading" ? "正在确认当前会话…" : "当前会话无法继续读取管理内容，请返回 MQ 重新确认账号。"}</p><a href="/">返回 MQ</a>
  </main>;
  // Account changes discard this workspace's private state and in-flight reads.
  // The public session is never treated as proof of administrator authorization.
  return <Workspace key={session.user.id} enabled={enabled} />;
}

function Workspace({ enabled }: { enabled: boolean }) {
  const [state, setState] = useState<CommentState>("PENDING");
  const [storyId, setStoryId] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [stories, setStories] = useState<Pick<DraftSummary, "id" | "draftTitle" | "state">[]>([]);
  const [storyCursor, setStoryCursor] = useState<string | null>(null);
  const [storiesBusy, setStoriesBusy] = useState(false);
  const [storiesError, setStoriesError] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [pending, setPending] = useState<{ id: string; reading: boolean } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const listRequest = useRef<AbortController | null>(null);
  const storyRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);

  const loadList = useCallback(async (next: string | null = null) => {
    listRequest.current?.abort();
    const controller = new AbortController(); listRequest.current = controller;
    setListBusy(true); setListError(null);
    try {
      const page = await commentAdminApi.list({ state, storyId, cursor: next }, controller.signal);
      if (!mounted.current || listRequest.current !== controller) return;
      setRows(previous => next ? [...previous, ...page.items.filter(item => !previous.some(row => row.comment.id === item.id)).map(comment => ({ comment }))]
        : page.items.map(comment => ({ comment })));
      setCount(page.count); setCursor(page.nextCursor);
    } catch (error) {
      if (!mounted.current || listRequest.current !== controller || controller.signal.aborted) return;
      if (error instanceof CommentAdminClientError && error.kind === "denied") setAccessLost(true);
      setListError(error instanceof CommentAdminClientError ? error.message : "暂时无法读取留言，请稍后重试。");
    } finally { if (mounted.current && listRequest.current === controller) setListBusy(false); }
  }, [state, storyId]);

  const loadStories = useCallback(async (next: string | null = null) => {
    storyRequest.current?.abort();
    const controller = new AbortController(); storyRequest.current = controller;
    setStoriesBusy(true); setStoriesError(null);
    try {
      const page = await draftApi.list(next, controller.signal);
      if (!mounted.current || storyRequest.current !== controller) return;
      setStories(previous => next ? [...previous, ...page.items.filter(item => !previous.some(story => story.id === item.id))] : page.items);
      setStoryCursor(page.nextCursor);
    } catch (error) {
      if (!mounted.current || storyRequest.current !== controller || controller.signal.aborted) return;
      if (error instanceof DraftClientError && error.kind === "denied") setAccessLost(true);
      setStoriesError("暂时无法读取故事选项。留言中的故事标签仍可使用。");
    } finally { if (mounted.current && storyRequest.current === controller) setStoriesBusy(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; listRequest.current?.abort(); storyRequest.current?.abort(); detailRequest.current?.abort(); };
  }, []);
  useEffect(() => { void loadList(); return () => listRequest.current?.abort(); }, [loadList]);
  useEffect(() => { void loadStories(); return () => storyRequest.current?.abort(); }, [loadStories]);

  async function moderate(row: Row, action: ModerationAction) {
    if (busy.current || accessLost || !enabled || row.needsCheck || listBusy) return;
    busy.current = true; setPending({ id: row.comment.id, reading: false });
    const sent = { action, version: row.comment.version };
    setRows(previous => previous.map(item => item.comment.id === row.comment.id ? { ...item, sent, message: undefined } : item));
    try {
      const result = await commentAdminApi.moderate(row.comment, action);
      if (!mounted.current) return;
      setRows(previous => previous.map(item => item.comment.id === row.comment.id
        ? { comment: { ...item.comment, ...result }, message: `已${actionName[action]}。服务器状态已确认。` } : item));
    } catch (error) {
      if (!mounted.current) return;
      if (error instanceof CommentAdminClientError && error.kind === "denied") setAccessLost(true);
      setRows(previous => previous.map(item => item.comment.id === row.comment.id ? { ...item, needsCheck: true,
        message: error instanceof CommentAdminClientError ? error.message : "审核结果尚未确认，请重新读取此留言。" } : item));
    } finally { busy.current = false; if (mounted.current) setPending(null); }
  }

  async function reconcile(row: Row) {
    if (busy.current || accessLost || listBusy) return;
    busy.current = true; setPending({ id: row.comment.id, reading: true });
    const controller = new AbortController(); detailRequest.current = controller;
    try {
      const comment = await commentAdminApi.get(row.comment.id, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setRows(previous => previous.map(item => item.comment.id === comment.id
        ? { comment, message: `已重新读取：${stateName[comment.state]}，版本 ${comment.version}。请根据当前状态决定。` } : item));
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      if (error instanceof CommentAdminClientError && error.kind === "denied") setAccessLost(true);
      setRows(previous => previous.map(item => item.comment.id === row.comment.id ? { ...item, needsCheck: true,
        message: "尚未取得此留言的当前状态。原内容保留，请稍后重新读取。" } : item));
    } finally { busy.current = false; if (mounted.current) setPending(null); }
  }

  if (accessLost) return <main className="comments-gate"><h1>管理权限已失效</h1><p role="alert">当前会话无法继续读取或审核留言，请返回 MQ 重新确认账号。</p><a href="/">返回 MQ</a></main>;
  const unresolved = rows.some(row => row.needsCheck);
  const blocked = pending !== null || listBusy;
  const filterBlocked = blocked || unresolved;
  const options = new Map(stories.map(story => [story.id, { title: story.draftTitle, state: story.state }]));
  rows.forEach(({ comment }) => options.set(comment.storyId, { title: comment.storyDraftTitle, state: comment.storyState }));
  const changeState = (value: CommentState) => { if (busy.current) return; setRows([]); setCount(null); setCursor(null); setState(value); };
  const changeStory = (value: string) => {
    if (busy.current) return;
    const selected = options.get(value);
    if (selected) setStories(previous => previous.some(story => story.id === value) ? previous
      : [...previous, { id: value, draftTitle: selected.title, state: selected.state }]);
    setRows([]); setCount(null); setCursor(null); setStoryId(value);
  };

  return <main className="comments-workspace" data-testid="comment-moderation-workspace">
    <header className="comments-topbar"><a href="/" className="comments-home"><span className="comments-brand">MQ</span><span>返回 MQ</span></a>
      <nav aria-label="管理工作区"><a href="/admin/stories">故事手稿</a><span aria-current="page">留言审核</span></nav></header>
    <div className="comments-heading"><h1>留言审核</h1><p>所有留言都经过审核，通过后才公开。这里仅管理员可见。</p></div>
    <section className="comments-content" aria-label="留言审核">
      {!enabled && <p className="comments-notice" role="status">审核写入暂未开放，仍可查看留言。</p>}
      <div className="comments-filters">
        <label>审核状态<select data-testid="comment-state-filter" value={state} disabled={filterBlocked} onChange={event => changeState(event.target.value as CommentState)}>
          {Object.entries(stateName).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
        </select></label>
        <label className="comments-story-filter">故事<select data-testid="comment-story-filter" value={storyId} disabled={filterBlocked} onChange={event => changeStory(event.target.value)}>
          <option value="">所有故事</option>{[...options].map(([id, story]) => <option key={id} value={id}>{story.title} · {storyStateName[story.state]}</option>)}
        </select></label>
        <button disabled={filterBlocked} onClick={() => void loadList()}>刷新留言列表</button>
      </div>
      {(storyCursor || storiesError) && <button className="comments-text-button" disabled={storiesBusy || filterBlocked} onClick={() => void loadStories(storiesError ? null : storyCursor)}>{storiesError ? "重试读取故事选项" : "更多故事选项"}</button>}
      {storiesError && <p className="comments-muted" role="status">{storiesError}</p>}
      <div className="comments-list-heading"><h2>{stateName[state]}留言 <span>{count === null ? "" : `最近读取时共 ${count} 条`}</span></h2>
        <p>已处理的留言保留在本页，刷新列表后按筛选重新读取。</p></div>
      {unresolved && <p className="comments-notice" role="status">请先重新读取结果待核对的留言，再切换或刷新列表。不会自动重复审核。</p>}
      {listError && <p role="alert" className="comments-notice">{listError}</p>}
      {listBusy && <p role="status" className="comments-muted">正在读取留言…</p>}
      {!listBusy && !listError && !rows.length && <div className="comments-empty"><span aria-hidden="true">✧</span><h3>此刻没有符合条件的留言</h3><p>可以切换筛选，或稍后刷新查看。</p></div>}
      <ul className="comments-list">{rows.map(row => {
        const item = row.comment, working = pending?.id === item.id;
        return <li key={item.id} data-testid="admin-comment-row" data-comment-id={item.id} data-state={item.state} className="comments-row">
          <div className="comments-row-heading"><div><span className="comments-author">{item.author}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN")}</time></div>
            <span className={`comments-badge is-${item.state.toLowerCase()}`}>{stateName[item.state]}</span></div>
          <p className="comments-story"><a href={`/admin/stories?story=${item.storyId}`}>{item.storyDraftTitle}</a><span>工作区标题 · {storyStateName[item.storyState]}</span>
            {storyId !== item.storyId && <button className="comments-text-button" disabled={filterBlocked} onClick={() => changeStory(item.storyId)}>只看此故事</button>}</p>
          <p className="comments-body">{item.body}</p>
          <div className="comments-actions">
            {item.state === "PENDING" && <><button className="comments-primary" disabled={blocked || !enabled || row.needsCheck || item.storyState !== "PUBLISHED"} onClick={() => void moderate(row, "approve")}>通过</button>
              <button disabled={blocked || !enabled || row.needsCheck} onClick={() => void moderate(row, "reject")}>拒绝</button></>}
            {item.state === "APPROVED" && <button disabled={blocked || !enabled || row.needsCheck} onClick={() => void moderate(row, "withdraw")}>撤回</button>}
            {row.needsCheck && <button className="comments-reconcile" disabled={blocked} onClick={() => void reconcile(row)}>重新读取此留言</button>}
            <span className="comments-muted">版本 {item.version}{item.state === "PENDING" && item.storyState !== "PUBLISHED" ? " · 故事未公开，暂不能通过" : ""}</span>
          </div>
          {working && <p role="status" className="comments-feedback">{pending.reading ? "正在读取当前状态…" : "正在提交审核决定…"}</p>}
          {row.message && <p role={row.needsCheck ? "alert" : "status"} className="comments-feedback">{row.message}</p>}
          {row.needsCheck && row.sent && <p className="comments-muted">上次发送：{actionName[row.sent.action]}，依据版本 {row.sent.version}。</p>}
        </li>;
      })}</ul>
      {cursor && <button className="comments-more" disabled={filterBlocked} onClick={() => void loadList(cursor)}>更多留言</button>}
      <p className="comments-footnote">通过后公开，拒绝或撤回后不公开。拒绝与撤回不能恢复为通过。</p>
    </section>
  </main>;
}
