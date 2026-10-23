"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useAuth, type AuthMode } from "./auth-provider";

export function AuthDialog({ initialMode, onClosed }: { initialMode: AuthMode; onClosed: () => void }) {
  const { authenticate } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const backdropPress = useRef(false);
  const id = useId();
  const [mode, setMode] = useState(initialMode);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isRegister = mode === "register";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const readerScroll = dialog.closest<HTMLElement>(".letter-scroll");
    const readingPosition = readerScroll?.scrollTop;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    dialog.showModal();
    usernameRef.current?.focus({ preventScroll: true });
    if (readerScroll && readingPosition !== undefined) readerScroll.scrollTop = readingPosition;
    return () => {
      dialog.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
      const focusTarget = previousFocus?.isConnected ? previousFocus
        : readerScroll ?? document.querySelector<HTMLElement>(".account-controls button");
      focusTarget?.focus({ preventScroll: true });
      if (readerScroll && readingPosition !== undefined) readerScroll.scrollTop = readingPosition;
    };
  }, []);

  function close() {
    if (busyRef.current) return;
    setPassword("");
    setConfirmation("");
    onClosed();
  }

  function switchMode() {
    if (busyRef.current) return;
    setMode(isRegister ? "login" : "register");
    setPassword("");
    setConfirmation("");
    setError("");
    usernameRef.current?.focus({ preventScroll: true });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) { setError("用户名需为 3–32 位英文字母、数字或下划线。"); return; }
    if (password.length < 12 || password.length > 128) { setError("密码需为 12–128 位，请使用较长且不重复的密码。"); return; }
    if (isRegister && password !== confirmation) { setError("两次输入的密码不一致，请重新确认。"); return; }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await authenticate(mode, username, password);
      setPassword("");
      setConfirmation("");
      onClosed();
    } catch (failure) {
      setPassword("");
      setConfirmation("");
      setError(failure instanceof Error && failure.name === "Error"
        ? failure.message : "连接暂时中断，请稍后重试。阅读不受影响。");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialogRef} className="auth-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}
    onPointerDown={(event) => { event.stopPropagation(); backdropPress.current = event.target === event.currentTarget; }}
    onClick={(event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget && backdropPress.current) close();
      backdropPress.current = false;
    }}>
    <section className="auth-panel">
      <button className="auth-close" type="button" aria-label="关闭账号窗口" disabled={busy} onClick={close}>×</button>
      <p className="auth-mark" aria-hidden="true">MQ</p>
      <h2 id={`${id}-title`}>{isRegister ? "相识于此" : "欢迎回来"}</h2>
      <p id={`${id}-intro`} className="auth-intro">{isRegister ? "用一个用户名，留下你的到访。" : "登录你的账号，继续这一页的时光。"}</p>
      <form onSubmit={submit} aria-busy={busy}>
        <label htmlFor={`${id}-username`}>用户名</label>
        <input ref={usernameRef} id={`${id}-username`} name="username" value={username}
          autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={32} required
          aria-describedby={`${id}-username-help`} disabled={busy} onChange={(event) => setUsername(event.target.value)} />
        <p id={`${id}-username-help`} className="auth-field-help">3–32 位英文字母、数字或下划线，不区分大小写。</p>
        <label htmlFor={`${id}-password`}>密码</label>
        <input id={`${id}-password`} name="password" type="password" value={password}
          autoComplete={isRegister ? "new-password" : "current-password"} minLength={12} maxLength={128} required
          aria-describedby={isRegister ? `${id}-password-help` : undefined} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
        {isRegister ? <>
          <p id={`${id}-password-help`} className="auth-field-help">12–128 位，请使用较长且不重复的密码。</p>
          <label htmlFor={`${id}-confirmation`}>确认密码</label>
          <input id={`${id}-confirmation`} name="password-confirmation" type="password" value={confirmation}
            autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy}
            onChange={(event) => setConfirmation(event.target.value)} />
        </> : null}
        <p className="auth-error" role="alert">{error}</p>
        <button className="auth-submit" type="submit" disabled={busy}>{busy ? "正在处理…" : isRegister ? "注册并登录" : "登录"}</button>
      </form>
      <p className="auth-switch">{isRegister ? "已经有账号？" : "还没有账号？"}<button type="button" disabled={busy} onClick={switchMode}>{isRegister ? "去登录" : "注册"}</button></p>
      <p className="auth-footnote">无需邮箱。当前不提供密码找回，请妥善保存密码。<br />不登录也可以继续阅读。</p>
    </section>
  </dialog>;
}
