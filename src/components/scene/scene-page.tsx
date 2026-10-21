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
    <div className="wordmark" role="img" aria-label="MQ · Our Stories">
      <svg className="wordmark-ornament" viewBox="0 0 200 24" fill="none" aria-hidden="true">
        <path d="M14 18C42 18 51 7 78 12M122 12C149 7 158 18 186 18M100 2L103 9L110 12L103 15L100 22L97 15L90 12L97 9Z" />
        <circle cx="83" cy="13" r="1" /><circle cx="117" cy="13" r="1" />
      </svg>
      <span className="wordmark-letters" aria-hidden="true">MQ</span>
      <span className="wordmark-subtitle" aria-hidden="true">Our Stories</span>
    </div>
  );
}

export function ScenePage({ section }: { section: Section }) {
  const isHome = section === "mq";

  return (
    <div className={`scene-page${isHome ? "" : " scene-page--construction"}`}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <Landscape />
      <header className="scene-header" data-scene-layer="ui">
        <Wordmark />
        <div className="account-placeholder">
          <button type="button" disabled aria-describedby="account-note">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="8" r="3.2" />
              <path d="M5.5 20v-2a6.5 6.5 0 0 1 13 0v2" />
            </svg>
            <span>登录 / 注册</span>
          </button>
          <span id="account-note">暂未开放</span>
        </div>
      </header>
      <nav className="scene-nav" aria-label="主页导航" data-scene-layer="ui">
        {navigation.map((item) => (
          <Link key={item.section} href={item.href} aria-label={item.name}
            aria-current={section === item.section ? "page" : undefined}>
            <span aria-hidden="true">{item.label}</span>
          </Link>
        ))}
      </nav>
      <main id="main-content" className="scene-content" tabIndex={-1}>
        {isHome ? (
          <div className="sr-only">
            <h1>MQ · Our Stories</h1>
            <p>夜空下，情侣并肩坐在茂盛的青草山坡上，身旁燃着篝火。</p>
            <p>当前为静态视觉原型。星空和篝火尚未开放交互。</p>
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
        <span>静态视觉原型 · 演示</span>
        <span className="scene-footer-brand">MQ · Our Stories</span>
      </footer>
    </div>
  );
}
