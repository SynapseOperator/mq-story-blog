import { clientIdentity, type AuthConfiguration } from "../auth/policy.ts";

export type AdminErrorCode = "ADMIN_UNAUTHENTICATED" | "ADMIN_FORBIDDEN" | "ADMIN_UNAVAILABLE"
  | "ADMIN_ORIGIN_REJECTED" | "ADMIN_PROXY_REJECTED" | "ADMIN_RATE_LIMITED" | "ADMIN_REQUEST_REJECTED";

export class AdminAccessError extends Error {
  readonly code: AdminErrorCode;
  readonly status: number;
  constructor(code: AdminErrorCode, status: number) {
    super(code);
    this.name = "AdminAccessError";
    this.code = code;
    this.status = status;
  }
}

/** Also applies to future mutating handlers: unsafe methods require the exact
 * Origin even without a cookie. Proxy identity is never accepted from bare XFF.
 */
export function inspectAdminRequest(request: Request, config: AuthConfiguration) {
  const client = clientIdentity(request, config);
  if (!client) throw new AdminAccessError("ADMIN_PROXY_REJECTED", 403);
  const origin = request.headers.get("origin");
  const safe = request.method === "GET" || request.method === "HEAD";
  if (request.headers.get("sec-fetch-site") === "cross-site"
    || (origin !== null && origin !== config.origin) || (!safe && origin !== config.origin)) {
    throw new AdminAccessError("ADMIN_ORIGIN_REJECTED", 403);
  }
  return client;
}
