"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FeatherLetter, type LetterNavigationHandle } from "../reader/feather-letter";
import type { LetterContentState } from "@/lib/stories/story";
import type { PublicStorySummary } from "@/lib/stories/public-story";
import { PublicStoryReadError, readPublicCatalog, readPublicStoryBySlug } from "@/lib/stories/public-client";
import { createStoryHistory } from "@/lib/stories/story-history";
import { Landscape } from "./landscape";
import { AccountControls } from "../auth/account-controls";

type Section = "mq" | "m" | "q";
type Catalog = { status: "loading" | "error" | "ready"; stories: PublicStorySummary[] };
type Reading = { slug: string; entry: { id: string; title: string }; content: LetterContentState };

function loadingStory(slug: string): Reading {
  return { slug, entry: { id: `slug:${slug}`, title: "MQ · 书信" }, content: { status: "loading" } };
}

const navigation = [
  { section: "mq", href: "/", label: "MQ", name: "MQ 共同主页" },
  { section: "m", href: "/m", label: "M", name: "M 个人主页（建设中）" },
  { section: "q", href: "/q", label: "Q", name: "Q 个人主页（建设中）" },
] as const;

function Wordmark() {
  return (
    <div className="wordmark" data-scene-layer="logo">
      <div className="wordmark-image">
        <img src="/scene/mq-logo.webp" alt="MQ · Our Stories" width="1536" height="1024" />
      </div>
      <p className="wordmark-caption">那些平凡的日子<span>因你而闪闪发光</span></p>
    </div>
  );
}

function NavigationIcon({ home = false }: { home?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {home ? (
        <path d="m2 10 10-8 10 8-2 2v9h-6v-7h-4v7H4v-9Z" fill="currentColor" stroke="none" />
      ) : (
        <><circle cx="12" cy="7" r="4" /><path d="M3.5 22v-3a8.5 8.5 0 0 1 17 0v3Z" /></>
      )}
    </svg>
  );
}

export function ScenePage({ section, initialStorySlug }: { section: Section; initialStorySlug?: string }) {
  const isHome = section === "mq";
  const [catalog, setCatalog] = useState<Catalog>({ status: "loading", stories: [] });
  const [reading, setReading] = useState<Reading | null>(() => initialStorySlug ? loadingStory(initialStorySlug) : null);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const readerOpen = useRef(Boolean(initialStorySlug));
  const history = useRef<ReturnType<typeof createStoryHistory> | null>(null);
  const letterNavigation = useRef<LetterNavigationHandle | null>(null);
  const initialSlug = useRef(initialStorySlug);
  const catalogRequest = useRef<AbortController | null>(null);
  const storyRequest = useRef<AbortController | null>(null);
  const selectedSummary = useRef<PublicStorySummary | null>(null);
  const readerTrigger = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const directoryTrigger = useRef<HTMLButtonElement | null>(null);

  const loadCatalog = useCallback(() => {
    catalogRequest.current?.abort();
    const request = new AbortController();
    catalogRequest.current = request;
    return readPublicCatalog(request.signal).then((stories) => {
      if (!request.signal.aborted && catalogRequest.current === request) setCatalog({ status: "ready", stories });
    }).catch(() => {
      if (!request.signal.aborted && catalogRequest.current === request) setCatalog({ status: "error", stories: [] });
    });
  }, []);

  const refreshCatalog = useCallback(() => {
    // User-triggered refresh removes stale entries. Initial state is already
    // loading; the mount effect only synchronizes with the external request.
    setCatalog({ status: "loading", stories: [] });
    return loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (isHome) void loadCatalog();
    return () => { catalogRequest.current?.abort(); storyRequest.current?.abort(); };
  }, [isHome, loadCatalog]);

  const loadStory = useCallback((slug: string, initial = false) => {
    storyRequest.current?.abort();
    const request = new AbortController();
    storyRequest.current = request;
    readerOpen.current = true;
    const known = selectedSummary.current?.slug === slug ? selectedSummary.current : null;
    if (!initial) { setReading({ ...loadingStory(slug), ...(known ? { entry: known } : {}) }); setDirectoryOpen(false); }
    document.title = "MQ · 书信";
    return readPublicStoryBySlug(slug, request.signal).then((story) => {
      if (!request.signal.aborted && storyRequest.current === request && readerOpen.current) {
        document.title = `${story.title} · MQ`;
        setReading({ slug, entry: { id: story.id, title: story.title }, content: { status: "ready", story: { ...story, source: "published" } } });
      }
    }).catch((error: unknown) => {
      if (!request.signal.aborted && storyRequest.current === request && readerOpen.current) {
        document.title = "MQ · 书信";
        setReading({ ...loadingStory(slug), entry: { id: known?.id ?? `slug:${slug}`, title: "MQ · 书信" },
          content: { status: "error", unavailable: error instanceof PublicStoryReadError && error.unavailable } });
      }
    });
  }, []);

  useEffect(() => {
    if (!isHome) return;
    const navigation = createStoryHistory(window, {
      hasReader: () => readerOpen.current,
      requestClose: () => letterNavigation.current?.requestClose() ?? false,
      onRoute: (slug, initial) => {
        if (slug) { void loadStory(slug, initial && slug === initialSlug.current); return; }
        storyRequest.current?.abort();
        storyRequest.current = null;
        readerOpen.current = false;
        document.title = "MQ · Our Stories";
        if (!initial || initialSlug.current) {
          restoreFocus.current = true;
          setReading(null);
          void refreshCatalog();
        }
      },
    }, crypto.randomUUID());
    history.current = navigation;
    return () => { navigation.dispose(); history.current = null; storyRequest.current?.abort(); };
  }, [isHome, loadStory, refreshCatalog]);

  function openStory(next: PublicStorySummary, trigger: HTMLButtonElement) {
    // The synchronous guard also covers multiple clicks before React commits.
    if (readerOpen.current) return;
    selectedSummary.current = next;
    readerTrigger.current = trigger;
    history.current?.open(next.slug);
  }

  const closeStory = useCallback(() => {
    storyRequest.current?.abort();
    storyRequest.current = null;
    // Keep the closed layer mounted until history commits. Clearing it before
    // popstate would restore focus to a hotspot that catalog refresh then removes.
    history.current?.closed();
  }, []);

  useEffect(() => {
    if (reading || (!readerTrigger.current && !restoreFocus.current) || catalog.status === "loading") return;
    // React must commit the restored visibility/disabled state before focus.
    // A requestAnimationFrame from closeStory can run before that commit.
    const trigger = readerTrigger.current;
    const renewedTrigger = trigger?.dataset.storyId
      ? document.querySelector<HTMLButtonElement>(`.story-entry[data-story-id="${CSS.escape(trigger.dataset.storyId)}"]`) : null;
    const target = trigger?.isConnected && trigger.getClientRects().length
      ? trigger : renewedTrigger ?? document.querySelector<HTMLButtonElement>(".story-entry--star")
        ?? document.querySelector<HTMLButtonElement>(".public-story-status button")
        ?? (directoryTrigger.current?.getClientRects().length ? directoryTrigger.current : document.getElementById("main-content"));
    target?.focus({ preventScroll: true });
    readerTrigger.current = null;
    restoreFocus.current = false;
  }, [reading, catalog.status]);

  return (
    <div className={`scene-page${isHome ? "" : " scene-page--construction"}${reading ? " scene-page--reading" : ""}`}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="scene-header" data-scene-layer="ui">
        <Wordmark />
        <AccountControls />
      </header>
      <nav className="scene-nav" aria-label="主页导航" data-scene-layer="ui">
        {navigation.map((item) => (
          <Link key={item.section} href={item.href} aria-label={item.name}
            aria-current={section === item.section ? "page" : undefined}>
            <NavigationIcon home={item.section === "mq"} />
            <span aria-hidden="true">{item.label}</span>
          </Link>
        ))}
      </nav>
      <main id="main-content" className="scene-content" tabIndex={-1}>
        <Landscape stories={catalog.stories} interactive={isHome} reading={Boolean(reading)} onRead={openStory} />
        {isHome ? (
          <div className="sr-only">
            <h1>MQ · Our Stories</h1>
            <p>夜空下，情侣并肩坐在茂盛的青草山坡上，身旁燃着篝火。</p>
            <p>选择已公开的故事星或篝火，在羽毛信中阅读。登录后可以点赞，也可以匿名或使用账号留言。</p>
          </div>
        ) : (
          <section className="construction" aria-labelledby="construction-title">
            <span className="construction-initial" aria-hidden="true">{section.toUpperCase()}</span>
            <h1 id="construction-title">{section.toUpperCase()} 的主页，建设中</h1>
            <p>这里的故事，留待以后慢慢写。</p>
            <Link href="/" className="return-link">回到 MQ 共同主页</Link>
          </section>
        )}
      </main>
      {isHome && (catalog.status !== "ready" || catalog.stories.length === 0) ?
        <div className="public-story-status" data-state={catalog.status === "ready" ? "empty" : catalog.status}
          role={catalog.status === "error" ? "alert" : "status"}>
          <p>{catalog.status === "loading" ? "正在寻找夜空中的故事……" : catalog.status === "error"
            ? "故事暂时无法加载，请重试。" : "这里还没有公开的故事。"}</p>
          {catalog.status === "error" ? <button type="button" aria-label="重试加载故事目录" onClick={() => void refreshCatalog()}>重试</button> : null}
        </div> : null}
      {isHome ? <aside className="memory-directory" aria-label="辅助回忆目录">
        <button ref={directoryTrigger} type="button" className="memory-toggle" aria-expanded={directoryOpen}
          aria-controls="memory-list" onClick={() => {
            if (!directoryOpen) void refreshCatalog();
            setDirectoryOpen(!directoryOpen);
          }}>
          <span aria-hidden="true">✧</span> 回忆目录 <span aria-hidden="true">{directoryOpen ? "−" : "+"}</span>
        </button>
        <div id="memory-list" className="memory-list" hidden={!directoryOpen} onKeyDown={(event) => {
          if (event.key === "Escape") { setDirectoryOpen(false); directoryTrigger.current?.focus(); }
        }}>
          <p>{catalog.status === "loading" ? "正在加载公开故事……" : catalog.status === "error"
            ? "目录加载失败，请重试。" : catalog.stories.length ? "公开故事" : "暂无公开故事"}</p>
          {catalog.status === "error" ? <button type="button" onClick={() => void refreshCatalog()}>重试目录</button> : null}
          {catalog.stories.map((item) => <button key={item.id} type="button" data-story-id={item.id} onClick={() => {
            if (directoryTrigger.current) openStory(item, directoryTrigger.current);
          }}><span aria-hidden="true">{item.entry === "campfire" ? "♧" : "✧"}</span>{item.title}</button>)}
        </div>
      </aside> : null}
      <footer className="scene-footer" data-scene-layer="ui">
        <span>{isHome ? "MQ · 公开故事" : "建设中"}</span>
        <span className="scene-footer-brand">MQ · Our Stories</span>
      </footer>
      {reading ? <FeatherLetter key={reading.slug} entry={reading.entry} content={reading.content}
        navigationRef={letterNavigation} onCloseCancelled={() => history.current?.cancel()}
        onRetry={() => { if (reading.content.status === "error") void loadStory(reading.slug); }} onClosed={closeStory} /> : null}
    </div>
  );
}
