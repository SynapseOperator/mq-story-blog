import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { username } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { protectedPrismaAdapter } from "./session-adapter.ts";
import { toNextJsHandler } from "better-auth/next-js";
import { createAuthDatabaseClient } from "./database.ts";
import { authConfiguration, AUTH_PATHS, credentials, inspectRequest, jsonReply } from "./policy.ts";
import { consumeAuthLimit } from "./rate-limit.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { createFrameworkRateLimitStorage } from "./framework-rate-limit.ts";
import { classifyAuthFailure, type AuthFailureStage } from "./failure.ts";
import { withAdminCredentialLock } from "../admin/login-lock.ts";

export type PublicSession = { user: { id: string; username: string }; session: { expiresAt: string } };

function publicUser(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const user = value as Record<string, unknown>;
  return typeof user.id === "string" && typeof user.username === "string" ? { id: user.id, username: user.username } : null;
}

function createService() {
  const config = authConfiguration();
  const db = createAuthDatabaseClient(config.databaseURL);
  // This object is deliberately private. Do not export auth.api mutation methods:
  // direct server calls bypass the HTTP admission/limiting boundary.
  const auth = betterAuth({
    appName: "MQ · Our Stories", baseURL: config.origin, secret: config.secret,
    trustedOrigins: [config.origin], database: protectedPrismaAdapter(db, config.sessionStorageKey),
    // Framework errors may include adapter values. Log only a fixed category;
    // neither request inputs nor framework Error objects enter application logs.
    logger: { level: "error", log: () => console.error("MQ_AUTH_FRAMEWORK_ERROR") },
    // Prevent better-call's fallback console.error from serializing raw adapter
    // errors. Known APIErrors retain their status; unexpected errors reach our
    // redacted outer catch (including a saturated password worker queue).
    onAPIError: { throw: true },
    emailAndPassword: { enabled: true, requireEmailVerification: false, minPasswordLength: 12, maxPasswordLength: 128,
      password: { hash: hashPassword, verify: verifyPassword } },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    session: { expiresIn: 86400, cookieCache: { enabled: false }, disableSessionRefresh: true },
    advanced: { useSecureCookies: config.secure, cookiePrefix: "mq", ipAddress: { ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, secure: config.secure, sameSite: "lax", path: "/" } },
    // Additional framework guard, not the primary granular limiter. Explicitly
    // configured even in development; do not trust arbitrary proxy IP headers.
    rateLimit: { enabled: true, customStorage: createFrameworkRateLimitStorage(db, config.secret), window: 60, max: 1000,
      customRules: Object.fromEntries([...AUTH_PATHS.keys()].map(path => [path, { window: 60, max: 1000 }])) },
    disabledPaths: ["/sign-in/email", "/change-email", "/update-user", "/request-password-reset", "/reset-password", "/send-verification-email", "/verify-email"],
    plugins: [username({ minUsernameLength: 3, maxUsernameLength: 32, usernameValidator: value => /^[a-zA-Z0-9_]{3,32}$/.test(value) })],
    hooks: { before: createAuthMiddleware(async ctx => {
      if (!AUTH_PATHS.has(ctx.path)) throw new APIError("NOT_FOUND", { message: "Disabled endpoint" });
      if (ctx.path === "/get-session") return;
      if (!ctx.request || ctx.request.headers.get("origin") !== config.origin
        || ctx.request.headers.get("sec-fetch-site") === "cross-site") throw new APIError("FORBIDDEN", { message: "HTTP origin required" });
      if (ctx.path === "/sign-out") {
        if (ctx.body && Object.keys(ctx.body).length) throw new APIError("BAD_REQUEST", { message: "Unexpected fields" });
        return;
      }
      const input = credentials(ctx.body);
      if (!input) throw new APIError("BAD_REQUEST", { message: "Invalid credentials format" });
      return { context: { body: ctx.path === "/sign-up/email"
        ? { ...input, name: input.username, email: `${randomUUID()}@accounts.invalid` } : input } };
    }) },
  });
  const handlers = toNextJsHandler(auth);
  return { config, db, handlers, auth };
}

// Connection/config singleton only: never retain per-request user/session state.
let service: ReturnType<typeof createService> | undefined;
function getService() { return service ??= createService(); }

async function publicResponse(response: Response, path: string) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.delete("content-length");
  headers.delete("location");
  let body: Record<string, unknown> | null = null;
  try { body = await response.json(); } catch { /* never pass through raw errors */ }
  let safe: unknown = null;
  if (!response.ok) {
    const known = new Set(["USERNAME_IS_ALREADY_TAKEN", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"]);
    const code = response.status === 429 ? "RATE_LIMITED" : response.status >= 500 ? "AUTH_INTERNAL_ERROR"
      : path === "/sign-in/username" ? "INVALID_CREDENTIALS"
      : known.has(String(body?.code)) ? "USERNAME_UNAVAILABLE" : "AUTH_REQUEST_REJECTED";
    safe = { code };
  } else if (path === "/sign-out") safe = { success: true };
  else if (body) {
    const user = publicUser(body.user);
    const session = body.session as Record<string, unknown> | undefined;
    safe = user ? { user, ...(typeof session?.expiresAt === "string" ? { session: { expiresAt: session.expiresAt } } : {}) } : null;
  }
  if (response.status === 429) headers.set("retry-after", headers.get("x-retry-after") ?? "60");
  return Response.json(safe, { status: response.status, headers });
}

export async function handleAuth(request: Request) {
  // Unknown endpoints cannot initialize connections or create limiter entries.
  const url = new URL(request.url);
  if (!AUTH_PATHS.has(url.pathname.slice("/api/auth".length))) return jsonReply(404, "DISABLED_ENDPOINT");
  let stage: AuthFailureStage = "config";
  try {
    const { config, db, handlers } = getService();
    stage = "framework";
    const inspected = await inspectRequest(request, config);
    if (inspected.response) return inspected.response;
    stage = "project-limit";
    const limit = await consumeAuthLimit(db, config.secret, inspected.path, inspected.client, inspected.input?.username);
    if (!limit.allowed) return Response.json({ code: "RATE_LIMITED" }, { status: 429,
      headers: { "cache-control": "no-store", "retry-after": String(limit.retryAfter) } });
    const handler = handlers[request.method as keyof typeof handlers];
    if (!handler) return jsonReply(405, "METHOD_NOT_ALLOWED");
    stage = "framework";
    const response = inspected.path === "/sign-in/username" && inspected.input
      ? await withAdminCredentialLock(db, config.databaseURL, inspected.input, () => handler(request))
      : await handler(request);
    return await publicResponse(response, inspected.path);
  } catch (error) {
    // Fixed provenance/category only; never serialize driver objects or values.
    const failure = classifyAuthFailure(error, stage);
    console.error(failure.event);
    return Response.json({ code: failure.code }, { status: failure.status,
      headers: { "cache-control": "no-store", ...(failure.retryAfter ? { "retry-after": String(failure.retryAfter) } : {}) } });
  }
}

/** Read-only server boundary for future authenticated services. Never returns a bearer token/email/role claim. */
export async function readSession(headers: Headers): Promise<PublicSession | null> {
  const verified = await readVerifiedSession(headers);
  return verified ? { user: verified.user, session: { expiresAt: verified.expiresAt } } : null;
}

/** Server-only identity proof for authorization. The session ID is not a bearer
 * token and must still be revalidated with the grant in the operation transaction.
 * Never serialize this internal object through a public authentication endpoint.
 */
export async function readVerifiedSession(headers: Headers) {
  try {
    const result = await getService().auth.api.getSession({ headers });
    const user = publicUser(result?.user);
    return user && result?.session ? { user, sessionId: result.session.id,
      expiresAt: result.session.expiresAt.toISOString() } : null;
  } catch { throw new Error("AUTH_UNAVAILABLE"); }
}
