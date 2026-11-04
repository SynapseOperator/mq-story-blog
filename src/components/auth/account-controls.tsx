"use client";

import { useState } from "react";
import { AuthDialog } from "./auth-dialog";
import { useAuth, type AuthMode } from "./auth-provider";

export function AccountControls({ reader = false }: { reader?: boolean }) {
  const { session, status, signOut, refresh } = useAuth();
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function logout() {
    if (pending) return;
    setPending(true);
    setError("");
    try { await signOut(); }
    catch { setError("退出暂未完成，请稍后重试。"); }
    finally { setPending(false); }
  }

  return <>
    <div className={reader ? "reader-account" : "account-placeholder account-controls"} aria-label={reader ? "信纸内账号" : "账号"}>
      {session ? <>
        <span className="account-username" title={session.user.username}>{session.user.username}</span>
        <button type="button" onClick={logout} disabled={pending}>{pending ? "正在退出…" : "退出"}</button>
      </> : <>
        <button type="button" disabled={status === "loading"} onClick={() => setMode("login")}>
          {!reader ? <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="7" r="4" /><path d="M3.5 22v-3a8.5 8.5 0 0 1 17 0v3Z" /></svg> : null}
          <span>{reader ? "登录账号" : "登录"}</span>
        </button>
        {!reader ? <button className="register-placeholder" type="button" disabled={status === "loading"} onClick={() => setMode("register")}>注册</button> : null}
        {reader ? <span className="reader-account-note">留言无需登录</span> : null}
      </>}
      {status === "unavailable" ? <button className="account-retry" type="button" onClick={() => { void refresh().catch(() => {}); }}>账号服务暂不可用 · 重试</button> : null}
      {error ? <span className="account-error" role="alert">{error}</span> : null}
    </div>
    {mode ? <AuthDialog initialMode={mode} appearance={reader ? "reader" : "default"} onClosed={() => setMode(null)} /> : null}
  </>;
}
