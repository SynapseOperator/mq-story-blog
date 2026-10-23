export type AuthFailureStage = "config" | "project-limit" | "framework";

// A marker carries provenance, never the driver message, query or values.
export class AuthLimiterError extends Error {
  readonly code = "AUTH_LIMITER_FAILURE";
  constructor() { super("Authentication limiter storage failed"); }
}

export function classifyAuthFailure(error: unknown, stage: AuthFailureStage) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (stage === "config") return { status: 503, code: "AUTH_UNAVAILABLE", event: "MQ_AUTH_CONFIG_UNAVAILABLE", retryAfter: 5 };
  if (stage === "project-limit" || code === "AUTH_LIMITER_FAILURE") {
    return { status: 503, code: "AUTH_LIMITER_ERROR", event: "MQ_AUTH_LIMITER_FAILURE", retryAfter: 5 };
  }
  if (code === "AUTH_HASH_BUSY") return { status: 503, code: "AUTH_HASH_BUSY", event: "MQ_AUTH_HASH_BUSY", retryAfter: 5 };
  if (["P1001", "P1002", "P1017", "ECONNREFUSED", "ETIMEDOUT"].includes(String(code))) {
    return { status: 503, code: "AUTH_STORAGE_UNAVAILABLE", event: "MQ_AUTH_STORAGE_UNAVAILABLE", retryAfter: 5 };
  }
  return { status: 500, code: "AUTH_INTERNAL_ERROR", event: "MQ_AUTH_INTERNAL_ERROR" };
}
