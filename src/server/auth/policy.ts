import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const AUTH_PATHS = new Map([
  ["/sign-up/email", "POST"], ["/sign-in/username", "POST"],
  ["/get-session", "GET"], ["/sign-out", "POST"],
]);

export function authConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.MQ_AUTH_ENABLED !== "true") throw new Error("AUTH_UNAVAILABLE");
  const origin = new URL(env.AUTH_ORIGIN ?? "invalid");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.href !== `${origin.origin}/` || origin.username || origin.password
    || (origin.protocol !== "https:" && !(local && origin.protocol === "http:" && env.AUTH_ALLOW_LOCAL_HTTP === "true"))) {
    throw new Error("AUTH_CONFIGURATION_INVALID");
  }
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32 || !env.DATABASE_URL) throw new Error("AUTH_CONFIGURATION_INVALID");
  if (env.AUTH_PROXY_SECRET && env.AUTH_PROXY_SECRET.length < 32) throw new Error("AUTH_CONFIGURATION_INVALID");
  // A public host must use a deliberately configured ingress, never raw XFF.
  if (!local && !env.AUTH_PROXY_SECRET) throw new Error("AUTH_PROXY_REQUIRED");
  return { origin: origin.origin, secret: env.AUTH_SECRET, databaseURL: env.DATABASE_URL,
    secure: origin.protocol === "https:", proxySecret: env.AUTH_PROXY_SECRET };
}
export type AuthConfiguration = ReturnType<typeof authConfiguration>;

export function jsonReply(status: number, code: string) {
  return Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
}

export function credentials(input: unknown): { username: string; password: string } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, "username") || !Object.hasOwn(value, "password")
    || typeof value.username !== "string" || typeof value.password !== "string"
    || !/^[a-zA-Z0-9_]{3,32}$/.test(value.username) || value.password.length < 12 || value.password.length > 128
    || !value.password.isWellFormed()) return null;
  return { username: value.username.toLowerCase(), password: value.password };
}

export function canonicalIp(value: string): string | null {
  if (!isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  if (normalized.startsWith("::ffff:")) {
    const parts = normalized.slice(7).split(":").map(v => Number.parseInt(v, 16));
    if (parts.length === 2) return [parts[0] >> 8, parts[0] & 255, parts[1] >> 8, parts[1] & 255].join(".");
  }
  // Group IPv6 privacy addresses by /64 so rotating the interface ID is not a bypass.
  const [left, right = ""] = normalized.split("::");
  const first = left ? left.split(":") : [];
  const last = right ? right.split(":") : [];
  const full = normalized.includes("::") ? [...first, ...Array(8 - first.length - last.length).fill("0"), ...last] : first;
  return `${full.slice(0, 4).map(v => Number.parseInt(v, 16).toString(16)).join(":")}::/64`;
}

export function clientIdentity(request: Request, config: AuthConfiguration): string | null {
  if (!config.proxySecret) return "local-untrusted";
  const supplied = request.headers.get("x-mq-proxy-key") ?? "";
  const expected = Buffer.from(config.proxySecret);
  const candidate = Buffer.from(supplied);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return null;
  return canonicalIp(request.headers.get("x-mq-client-ip") ?? "");
}

/** Runs before framework parsing, logging, and DB limiting. */
export async function inspectRequest(request: Request, config: AuthConfiguration) {
  const url = new URL(request.url);
  const path = url.pathname.slice("/api/auth".length);
  if (!url.pathname.startsWith("/api/auth/") || !AUTH_PATHS.has(path)) return { response: jsonReply(404, "DISABLED_ENDPOINT") };
  if (AUTH_PATHS.get(path) !== request.method) return { response: jsonReply(405, "METHOD_NOT_ALLOWED") };
  if (url.search) return { response: jsonReply(400, "QUERY_NOT_ALLOWED") };
  const client = clientIdentity(request, config);
  if (!client) return { response: jsonReply(403, "UNTRUSTED_PROXY") };
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site" || (origin !== null && origin !== config.origin)
    || (request.method === "POST" && origin !== config.origin)) return { response: jsonReply(403, "UNTRUSTED_ORIGIN") };
  if (request.method === "GET") return { path, client, input: null };
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") return { response: jsonReply(415, "JSON_REQUIRED") };
  const reader = request.clone().body?.getReader();
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) { void reader.cancel(); return { response: jsonReply(413, "BODY_TOO_LARGE") }; }
      }
    } finally { reader.releaseLock(); }
  }
  let body: unknown;
  try { body = await request.clone().json(); } catch { return { response: jsonReply(400, "INVALID_INPUT") }; }
  if (path === "/sign-out") {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) return { response: jsonReply(400, "INVALID_INPUT") };
    return { path, client, input: null };
  }
  const input = credentials(body);
  if (!input) return { response: jsonReply(400, "INVALID_INPUT") };
  return { path, client, input };
}
