import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { PasswordWorkQueue } from "./hash-work-queue.ts";

export { AuthHashBusyError } from "./hash-work-queue.ts";

// OWASP's 32 MiB scrypt profile. Explicitly versioned; stored parameters are never executed.
// Better Auth's documented emailAndPassword.password hooks call these functions.
export const PASSWORD_HASH_POLICY = Object.freeze({
  version: 1,
  N: 32768,
  r: 8,
  p: 3,
  keyBytes: 64,
  saltBytes: 16,
  maxmem: 48 * 1024 * 1024,
  maxConcurrent: 2,
  maxQueued: 4,
  maxPasswordCodeUnits: 128,
  normalization: "NFKC",
});

const prefix = "$mq-scrypt$v=1$N=32768,r=8,p=3$";
const encodedLength = prefix.length + 32 + 1 + 128;
const encodedPattern = /^\$mq-scrypt\$v=1\$N=32768,r=8,p=3\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

// Keep one limiter across server module copies/HMR in this process. It holds only bounded
// transient work, never a cached user, session or request-specific authorization decision.
const processState = globalThis as typeof globalThis & { __mqPasswordWorkQueueV1?: PasswordWorkQueue };
const queue = (processState.__mqPasswordWorkQueueV1 ??= new PasswordWorkQueue());

function normalizePassword(password: string): string {
  if (
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > PASSWORD_HASH_POLICY.maxPasswordCodeUnits ||
    !password.isWellFormed()
  ) {
    throw new TypeError("Invalid password input.");
  }
  // Preserve Better Auth's normalization semantics, without trimming or truncating.
  return password.normalize("NFKC");
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return queue.run(() => new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, PASSWORD_HASH_POLICY.keyBytes, {
      N: PASSWORD_HASH_POLICY.N,
      r: PASSWORD_HASH_POLICY.r,
      p: PASSWORD_HASH_POLICY.p,
      maxmem: PASSWORD_HASH_POLICY.maxmem,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  }));
}

export async function hashPassword(password: string): Promise<string> {
  const normalized = normalizePassword(password);
  const salt = randomBytes(PASSWORD_HASH_POLICY.saltBytes);
  const key = await derive(normalized, salt);
  try {
    return `${prefix}${salt.toString("hex")}$${key.toString("hex")}`;
  } finally {
    key.fill(0);
  }
}

export async function verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
  // Reject corrupt/foreign hashes before allocating scrypt work. Never trust a stored cost.
  if (typeof input.hash !== "string" || input.hash.length !== encodedLength) return false;
  const match = encodedPattern.exec(input.hash);
  if (!match) return false;
  let normalized: string;
  try {
    normalized = normalizePassword(input.password);
  } catch {
    return false;
  }
  const expected = Buffer.from(match[2], "hex");
  const actual = await derive(normalized, Buffer.from(match[1], "hex"));
  try {
    return timingSafeEqual(actual, expected);
  } finally {
    actual.fill(0);
    expected.fill(0);
  }
}
