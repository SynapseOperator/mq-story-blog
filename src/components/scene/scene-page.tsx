"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FeatherLetter } from "../reader/feather-letter";
import type { Story } from "@/lib/stories/story";
import type { SceneStory } from "@/lib/stories/scene-catalog";
import { Landscape } from "./landscape";
import { AccountControls } from "../auth/account-controls";

type Section = "mq" | "m" | "q";
const noStories: readonly SceneStory[] = [];

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

export function ScenePage({ section, stories = noStories }: { section: Section; stories?: readonly SceneStory[] }) {
  const isHome = section === "mq";
  const [story, setStory] = useState<Story | null>(null);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const readerOpen = useRef(false);
  const readerTrigger = useRef<HTMLButtonElement | null>(null);
  const directoryTrigger = useRef<HTMLButtonElement | null>(null);

  function openStory(next: Story, trigger: HTMLButtonElement) {
    // The synchronous guard also covers multiple clicks before React commits.
    if (readerOpen.current) return;
    readerOpen.current = true;
    readerTrigger.current = trigger;
    setDirectoryOpen(false);
    setStory(next);
  }

  const closeStory = useCallback(() => {
    setStory(null);
    readerOpen.current = false;
  }, []);

  useEffect(() => {
    if (story || !readerTrigger.current) return;
    // React must commit the restored visibility/disabled state before focus.
    // A requestAnimationFrame from closeStory can run before that commit.
    const trigger = readerTrigger.current;
    const target = trigger.isConnected && trigger.getClientRects().length
      ? trigger : document.querySelector<HTMLButtonElement>(".story-entry--star");
    target?.focus({ preventScroll: true });
    readerTrigger.current = null;
  }, [story]);

  return (
    <div className={`scene-page${isHome ? "" : " scene-page--construction"}${story ? " scene-page--reading" : ""}`}>
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
        <Landscape stories={stories} interactive={isHome} reading={Boolean(story)} onRead={openStory} />
        {isHome ? (
          <div className="sr-only">
            <h1>MQ · Our Stories</h1>
            <p>夜空下，情侣并肩坐在茂盛的青草山坡上，身旁燃着篝火。</p>
            <p>当前为交互原型，文章与图片均为合成演示。选择故事星或篝火，在羽毛信中阅读。</p>
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
      {isHome ? <aside className="memory-directory" aria-label="辅助回忆目录">
        <button ref={directoryTrigger} type="button" className="memory-toggle" aria-expanded={directoryOpen}
          aria-controls="memory-list" onClick={() => setDirectoryOpen(!directoryOpen)}>
          <span aria-hidden="true">✧</span> 回忆目录 <span aria-hidden="true">{directoryOpen ? "−" : "+"}</span>
        </button>
        <div id="memory-list" className="memory-list" hidden={!directoryOpen} onKeyDown={(event) => {
          if (event.key === "Escape") { setDirectoryOpen(false); directoryTrigger.current?.focus(); }
        }}>
          <p>合成演示故事</p>
          {stories.map((item) => <button key={item.id} type="button" onClick={() => {
            if (directoryTrigger.current) openStory(item, directoryTrigger.current);
          }}><span aria-hidden="true">{item.entry === "campfire" ? "♧" : "✧"}</span>{item.title}</button>)}
        </div>
      </aside> : null}
      <footer className="scene-footer" data-scene-layer="ui">
        <span>{isHome ? "交互原型 · 合成演示" : "建设中 · 演示"}</span>
        <span className="scene-footer-brand">MQ · Our Stories</span>
      </footer>
      {story ? <FeatherLetter key={story.id} story={story} onClosed={closeStory} /> : null}
    </div>
  );
}
