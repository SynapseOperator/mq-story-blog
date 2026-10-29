import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.ts";
import { credentials } from "../auth/policy.ts";
import { hashPassword } from "../auth/password.ts";

export type AdminMaintenanceCode = "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" | "INITIALIZED" | "MAINTENANCE_FAILED";

/** Fixed errors only: an offline caller must never log raw Prisma/driver errors. */
export class AdminMaintenanceError extends Error {
  readonly code: AdminMaintenanceCode;
  constructor(code: AdminMaintenanceCode) {
    super(code);
    this.name = "AdminMaintenanceError";
    this.code = code;
  }
}

type GrantRow = { userId: string; version: number; revokedAt: Date | null };
type GrantTarget = { userId: string; expectedVersion: number };
export type AdminMaintenanceResult = { userId: string; version: number };
const transactionOptions = { maxWait: 5000, timeout: 5000 };

function validTarget(input: GrantTarget): void {
  if (!input || typeof input.userId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.userId)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion >= 2_147_483_647) {
    throw new AdminMaintenanceError("INVALID_INPUT");
  }
}

function onlyKeys(input: object, keys: string[]) {
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))) {
    throw new AdminMaintenanceError("INVALID_INPUT");
  }
}

async function transaction<T>(db: PrismaClient, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try { return await db.$transaction(operation, transactionOptions); }
  catch (error) {
    if (error instanceof AdminMaintenanceError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "P2002" || code === "23505") throw new AdminMaintenanceError("CONFLICT");
    throw new AdminMaintenanceError("MAINTENANCE_FAILED");
  }
}

async function lockedGrant(tx: Prisma.TransactionClient, input: GrantTarget): Promise<GrantRow> {
  const rows = await tx.$queryRaw<GrantRow[]>`
    SELECT "userId", "version", "revokedAt" FROM public."AdminGrant" WHERE "id" = 1 FOR UPDATE`;
  const grant = rows[0];
  if (!grant || grant.userId !== input.userId) throw new AdminMaintenanceError("NOT_FOUND");
  if (grant.version !== input.expectedVersion) throw new AdminMaintenanceError("CONFLICT");
  return grant;
}

/** Offline maintenance only. This never promotes an existing public account. */
export async function initializeAdmin(db: PrismaClient, input: { username: string; password: string }): Promise<AdminMaintenanceResult> {
  const normalized = credentials(input);
  if (!normalized) throw new AdminMaintenanceError("INVALID_INPUT");
  // Hash before acquiring database locks; secrets stay in memory, not audit rows.
  let hash: string;
  try { hash = await hashPassword(normalized.password); }
  catch { throw new AdminMaintenanceError("MAINTENANCE_FAILED"); }
  const userId = randomUUID();
  return transaction(db, async tx => {
    const existing = await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM public."AdminGrant" WHERE "id" = 1`;
    if (existing.length) throw new AdminMaintenanceError("INITIALIZED");
    await tx.user.create({ data: {
      id: userId, name: normalized.username, username: normalized.username,
      displayUsername: normalized.username, email: `${randomUUID()}@accounts.invalid`, emailVerified: false,
    }, select: { id: true } });
    await tx.account.create({ data: {
      id: randomUUID(), userId, accountId: userId, providerId: "credential", password: hash,
    }, select: { id: true } });
    // The singleton CHECK + primary key is the concurrency authority. A losing
    // initializer rolls back its User and Account as well as its grant attempt.
    const rows = await tx.$queryRaw<AdminMaintenanceResult[]>`
      INSERT INTO public."AdminGrant" ("id", "userId", "version") VALUES (1, ${userId}, 0)
      RETURNING "userId", "version"`;
    return rows[0];
  });
}

async function changeGrant(db: PrismaClient, input: GrantTarget, revoke: boolean): Promise<AdminMaintenanceResult> {
  validTarget(input);
  onlyKeys(input, ["userId", "expectedVersion"]);
  return transaction(db, async tx => {
    const grant = await lockedGrant(tx, input);
    if ((grant.revokedAt === null) !== revoke) throw new AdminMaintenanceError("INVALID_STATE");
    const rows = revoke
      ? await tx.$queryRaw<AdminMaintenanceResult[]>`
          UPDATE public."AdminGrant" SET "revokedAt" = clock_timestamp(), "version" = "version" + 1
          WHERE "id" = 1 AND "userId" = ${input.userId} AND "version" = ${input.expectedVersion} AND "revokedAt" IS NULL
          RETURNING "userId", "version"`
      : await tx.$queryRaw<AdminMaintenanceResult[]>`
          UPDATE public."AdminGrant" SET "revokedAt" = NULL, "version" = "version" + 1
          WHERE "id" = 1 AND "userId" = ${input.userId} AND "version" = ${input.expectedVersion} AND "revokedAt" IS NOT NULL
          RETURNING "userId", "version"`;
    if (rows.length !== 1) throw new AdminMaintenanceError("CONFLICT");
    // Native triggers append the event and delete every existing Session in this
    // same transaction. Failure of either part prevents the state transition.
    return rows[0];
  });
}

export function revokeAdmin(db: PrismaClient, input: GrantTarget) { return changeGrant(db, input, true); }
export function restoreAdmin(db: PrismaClient, input: GrantTarget) { return changeGrant(db, input, false); }

export async function resetAdminPassword(db: PrismaClient, input: GrantTarget & { password: string }): Promise<AdminMaintenanceResult> {
  validTarget(input);
  onlyKeys(input, ["userId", "expectedVersion", "password"]);
  if (!credentials({ username: "validation_only", password: input.password })) throw new AdminMaintenanceError("INVALID_INPUT");
  let hash: string;
  try { hash = await hashPassword(input.password); }
  catch { throw new AdminMaintenanceError("MAINTENANCE_FAILED"); }
  return transaction(db, async tx => {
    await lockedGrant(tx, input);
    const changed = await tx.account.updateMany({
      where: { userId: input.userId, accountId: input.userId, providerId: "credential" },
      data: { password: hash, updatedAt: new Date() },
    });
    if (changed.count !== 1) throw new AdminMaintenanceError("INVALID_STATE");
    // The native password trigger advances the grant/credential version,
    // invalidates ALL sessions and audits reset, including raw SQL maintenance.
    const rows = await tx.$queryRaw<AdminMaintenanceResult[]>`
      SELECT "userId", "version" FROM public."AdminGrant" WHERE "id" = 1`;
    if (rows[0]?.version !== input.expectedVersion + 1) throw new AdminMaintenanceError("MAINTENANCE_FAILED");
    return rows[0];
  });
}
