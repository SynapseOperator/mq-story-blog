import Link from "next/link";
import { Landscape } from "./landscape";

type Section = "mq" | "m" | "q";

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

export function ScenePage({ section }: { section: Section }) {
  const isHome = section === "mq";

  return (
    <div className={`scene-page${isHome ? "" : " scene-page--construction"}`}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="scene-header" data-scene-layer="ui">
        <Wordmark />
        <div className="account-placeholder">
          <button type="button" disabled aria-describedby="account-note">
            <NavigationIcon />
            <span>登录</span>
          </button>
          <button className="register-placeholder" type="button" disabled aria-describedby="account-note">注册</button>
          <span id="account-note">暂未开放</span>
        </div>
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
        <Landscape interactive={isHome} />
        {isHome ? (
          <div className="sr-only">
            <h1>MQ · Our Stories</h1>
            <p>夜空下，情侣并肩坐在茂盛的青草山坡上，身旁燃着篝火。</p>
            <p>当前为交互原型，故事标题均为合成演示。选择故事星或篝火可验证故事入口，阅读器尚未开放。</p>
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
      <footer className="scene-footer" data-scene-layer="ui">
        <span>{isHome ? "交互原型 · 合成演示" : "建设中 · 演示"}</span>
        <span className="scene-footer-brand">MQ · Our Stories</span>
      </footer>
    </div>
  );
}
