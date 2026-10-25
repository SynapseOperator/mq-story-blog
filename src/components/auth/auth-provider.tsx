"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type PublicSession = {
  user: { id: string; username: string };
  session: { expiresAt: string };
};
type AuthStatus = "loading" | "anonymous" | "authenticated" | "unavailable";
export type AuthMode = "login" | "register";

type AuthContextValue = {
  session: PublicSession | null;
  status: AuthStatus;
  refresh: () => Promise<PublicSession | null>;
  authenticate: (mode: AuthMode, username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function publicSession(value: unknown): PublicSession | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !("user" in value) || !("session" in value)) throw new Error("会话暂时无法读取，请稍后重试。");
  const { user, session } = value;
  if (!user || typeof user !== "object" || !("id" in user) || !("username" in user)
    || typeof user.id !== "string" || typeof user.username !== "string"
    || !session || typeof session !== "object" || !("expiresAt" in session)
    || typeof session.expiresAt !== "string" || !Number.isFinite(Date.parse(session.expiresAt))) {
    throw new Error("会话暂时无法读取，请稍后重试。");
  }
  // Copy the explicit public contract, never keep the framework's user/token object.
  return { user: { id: user.id, username: user.username }, session: { expiresAt: session.expiresAt } };
}

function requestError(status: number, mode?: AuthMode): Error {
  if (status === 429) return new Error("尝试次数较多，请稍等片刻再试。");
  if (status === 401) return new Error("用户名或密码不正确，请重新输入。");
  if (status === 403) return new Error("请求未通过安全检查，请刷新页面后重试。");
  if (status === 409 && mode === "register") return new Error("这个用户名暂不可用，请换一个重试。");
  if (status === 400 || status === 422) return new Error(mode === "register"
    ? "请检查用户名和密码；如果用户名已被使用，请换一个重试。"
    : "请检查用户名和密码后重试。");
  return new Error("账号服务暂时不可用，请稍后重试。阅读不受影响。");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PublicSession | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const generation = useRef(0);
  const mutationPending = useRef(false);
  const invalidateReads = useCallback(() => { generation.current++; }, []);

  const refresh = useCallback(async () => {
    const requestGeneration = ++generation.current;
    try {
      const response = await fetch("/api/auth/get-session", {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw requestError(response.status);
      const next = publicSession(await response.json());
      if (requestGeneration === generation.current) {
        setSession(next);
        setStatus(next ? "authenticated" : "anonymous");
      }
      return next;
    } catch {
      if (requestGeneration === generation.current) {
        setSession(null);
        setStatus("unavailable");
      }
      throw new Error("账号服务暂时不可用，请稍后重试。阅读不受影响。");
    }
  }, []);

  useEffect(() => {
    function recheck() {
      if (!mutationPending.current && document.visibilityState === "visible") void refresh().catch(() => {});
    }
    recheck();
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      invalidateReads();
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [refresh, invalidateReads]);

  useEffect(() => {
    if (!session) return;
    const remaining = Math.max(0, Date.parse(session.session.expiresAt) - Date.now());
    const timer = setTimeout(() => { void refresh().catch(() => {}); }, Math.min(remaining + 100, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [session, refresh]);

  const authenticate = useCallback(async (mode: AuthMode, username: string, password: string) => {
    if (mutationPending.current) throw new Error("正在处理上一次请求，请稍候。");
    mutationPending.current = true;
    generation.current++;
    try {
      const response = await fetch(mode === "register" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/username", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw requestError(response.status, mode);
      if (!await refresh()) throw new Error("暂未取得有效登录状态，请重新登录。");
    } finally { mutationPending.current = false; }
  }, [refresh]);

  const signOut = useCallback(async () => {
    if (mutationPending.current) throw new Error("正在处理上一次请求，请稍候。");
    mutationPending.current = true;
    generation.current++;
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw requestError(response.status);
      setSession(null);
      setStatus("anonymous");
    } finally { mutationPending.current = false; }
  }, []);

  const value = useMemo(() => ({ session, status, refresh, authenticate, signOut }), [session, status, refresh, authenticate, signOut]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("AuthProvider is required.");
  return context;
}
