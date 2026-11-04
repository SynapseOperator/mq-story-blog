import { AdminAccessError } from "../policy.ts";

export type PublishAction = "slot" | "publish" | "withdraw" | "restore";
export type PublishCode = "PUBLISH_VALIDATION" | "PUBLISH_NOT_FOUND" | "PUBLISH_CONFLICT"
  | "PUBLISH_INVALID_STATE" | "PUBLISH_MEDIA_UNAVAILABLE" | "PUBLISH_UNAVAILABLE";
const statuses = { PUBLISH_VALIDATION: 400, PUBLISH_NOT_FOUND: 404, PUBLISH_CONFLICT: 409,
  PUBLISH_INVALID_STATE: 409, PUBLISH_MEDIA_UNAVAILABLE: 503, PUBLISH_UNAVAILABLE: 503 } as const;
export class PublicationError extends AdminAccessError {
  readonly publicationCode: PublishCode;
  constructor(code: PublishCode) { super("ADMIN_REQUEST_REJECTED", statuses[code]); this.publicationCode = code; }
}

export function publicationInput(input: unknown, action: PublishAction) {
  const allowed = action === "slot" ? ["expectedVersion", "slotId"] : ["expectedVersion"];
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PublicationError("PUBLISH_VALIDATION");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== allowed.length || allowed.some(key => !Object.hasOwn(value, key))
    || !Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 0
    || (value.expectedVersion as number) >= 2_147_483_647
    || (action === "slot" && value.slotId !== null
      && (typeof value.slotId !== "string" || !/^[a-z0-9-]{1,64}$/.test(value.slotId)))) {
    throw new PublicationError("PUBLISH_VALIDATION");
  }
  return { expectedVersion: value.expectedVersion as number, slotId: (value.slotId ?? null) as string | null };
}

// Only this independent key is used. No fallback to Better Auth's signing key.
export function publicationKey() {
  const key = process.env.MQ_PUBLISH_SIGNING_KEY;
  if (process.env.MQ_PUBLISH_ENABLED !== "true" || !/^[a-f0-9]{64}$/.test(key ?? "")
    || key === process.env.AUTH_SECRET || key === process.env.BETTER_AUTH_SECRET || key === process.env.MQ_AUTH_SECRET) {
    throw new PublicationError("PUBLISH_UNAVAILABLE");
  }
  return Buffer.from(key!, "hex");
}
