import { randomUUID } from "node:crypto";
import type { BetterAuthOptions } from "better-auth";
import type { DBAdapter, DBTransactionAdapter, JoinOption, Where } from "better-auth/adapters";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.ts";
import { createSessionCodec, SessionStorageError, type SessionStorageRow } from "./session-storage.ts";

type Row = Record<string, unknown>;
const proofFields = ["id", "userId", "token", "tokenCiphertext", "createdAt", "expiresAt"];
const snapshotFields = [...proofFields, "updatedAt", "ipAddress", "userAgent"];

/** Supported public DBAdapter composition, not a patched framework adapter.
 * Session updates use transactional compare/consume/insert: MQ's runtime keeps
 * its existing SELECT/INSERT/DELETE rights and never receives Session UPDATE. */
export function protectedPrismaAdapter(db: PrismaClient, key: string) {
  const codec = createSessionCodec(key);
  const where = (items?: Where[]) => items?.map(item => {
    if (item.field === "tokenCiphertext") throw new SessionStorageError();
    if (item.field !== "token") return item;
    if (item.mode === "insensitive" || ![undefined, "eq", "ne", "in", "not_in"].includes(item.operator)) throw new SessionStorageError();
    return { ...item, value: Array.isArray(item.value)
      ? item.value.map(value => codec.index(value as string)) : codec.index(item.value as string) };
  });
  const projection = (row: Row, select?: string[], join?: JoinOption) => !select?.length ? row
    : Object.fromEntries(Object.entries(row).filter(([field]) => select.includes(field) || Boolean(join?.[field])));
  const decode = (row: Row, model: string, select?: string[], join?: JoinOption) => {
    const result: Row = model === "session" ? codec.open(row as SessionStorageRow) : { ...row };
    // The official factory normalizes joined keys to the canonical model name,
    // for both native Prisma joins and its separate-query join fallback.
    if (model !== "session" && join?.session && result.session != null) result.session = Array.isArray(result.session)
      ? result.session.map(value => codec.open(value as SessionStorageRow)) : codec.open(result.session as SessionStorageRow);
    return projection(result, select, join);
  };
  const selection = (select?: string[]) => select?.length ? [...new Set([...select, ...proofFields])] : undefined;

  return (options: BetterAuthOptions): DBAdapter => {
    // Other stores/caches or custom identity fields could bypass this boundary.
    // They require a separately reviewed adapter contract before activation.
    if (options.secondaryStorage || options.session?.cookieCache?.enabled
      || options.session?.modelName && options.session.modelName !== "session"
      || Object.keys(options.session?.fields ?? {}).length
      || Object.keys(options.session?.additionalFields ?? {}).length
      || options.plugins?.some(plugin => plugin.schema?.session)
      || options.advanced?.database?.generateId !== undefined && options.advanced.database.generateId !== "uuid") throw new SessionStorageError();
    const storageOptions: BetterAuthOptions = { ...options, session: { ...options.session, additionalFields: {
      tokenCiphertext: { type: "string", required: true, input: false, returned: false },
    } } };
    const baseFor = (client: Prisma.TransactionClient) => prismaAdapter(client,
      { provider: "postgresql", transaction: false })(storageOptions);

    function wrap(current: DBTransactionAdapter, client: Prisma.TransactionClient, insideTransaction: boolean): DBAdapter {
      const atomic = <T>(operation: (tx: DBTransactionAdapter, sql: Prisma.TransactionClient) => Promise<T>) => insideTransaction
        ? operation(current, client) : db.$transaction(tx => operation(baseFor(tx), tx));
      const replace = async (tx: DBTransactionAdapter, original: Row, update: Row) => {
        const raw = codec.open(original as SessionStorageRow);
        if (["id", "userId", "token", "tokenCiphertext"].some(field => field in update)) throw new SessionStorageError();
        const claimed = await tx.consumeOne<Row>({ model: "session", where: snapshotFields.map(field => ({
          field, value: original[field] as Where["value"], operator: "eq", connector: "AND",
        })) });
        if (!claimed) return null;
        // Claim exactly the verified snapshot, never a broad OR predicate. A
        // concurrent revoke wins without this write resurrecting its session.
        codec.open(claimed as SessionStorageRow);
        const stored = codec.seal({ ...raw, ...update, updatedAt: update.updatedAt ?? new Date() } as SessionStorageRow);
        const inserted = await tx.create<Row>({ model: "session", data: stored, forceAllowId: true });
        return decode(inserted, "session");
      };
      return {
        ...current,
        transaction: callback => atomic((tx, sql) => callback(wrap(tx, sql, true))),
        async create<T extends Row, R = T>(input: { model: string; data: Omit<T, "id">; select?: string[]; forceAllowId?: boolean }): Promise<R> {
          if (input.model !== "session") return current.create<T, R>(input);
          if ("tokenCiphertext" in input.data) throw new SessionStorageError();
          const now = new Date();
          const row: Row = { ...input.data, id: input.forceAllowId && input.data.id ? input.data.id : randomUUID(),
            createdAt: input.data.createdAt ?? now, updatedAt: input.data.updatedAt ?? now };
          const stored = await current.create<Row>({ model: "session", data: codec.seal(row as SessionStorageRow), forceAllowId: true });
          return decode(stored, "session", input.select) as R;
        },
        async findOne<T>(input: Parameters<DBAdapter["findOne"]>[0]): Promise<T | null> {
          const row = await current.findOne<Row>(input.model === "session"
            ? { ...input, where: where(input.where)!, select: selection(input.select) } : input);
          return row ? decode(row, input.model, input.select, input.join) as T : null;
        },
        async findMany<T>(input: Parameters<DBAdapter["findMany"]>[0]): Promise<T[]> {
          if (input.model === "session" && ["token", "tokenCiphertext"].includes(input.sortBy?.field ?? "")) throw new SessionStorageError();
          const rows = await current.findMany<Row>(input.model === "session"
            ? { ...input, where: where(input.where), select: selection(input.select) } : input);
          return rows.map(row => decode(row, input.model, input.select, input.join) as T);
        },
        count: input => current.count(input.model === "session" ? { ...input, where: where(input.where) } : input),
        async update<T>(input: Parameters<DBAdapter["update"]>[0]): Promise<T | null> {
          if (input.model !== "session") return current.update<T>(input);
          if (!input.where.length) return null;
          return atomic(async (tx, sql) => {
            // PostgreSQL DELETE waiting on a deleted/reinserted tuple can miss
            // its replacement. Acquire this short write lock before the read,
            // so both adapter revocation and native maintenance DELETE observe
            // one complete version. Existing DELETE privilege permits the lock;
            // SELECT remains concurrent and no UPDATE privilege is granted.
            await sql.$executeRaw`LOCK TABLE public."Session" IN SHARE ROW EXCLUSIVE MODE`;
            const row = await tx.findOne<Row>({ model: "session", where: where(input.where)! });
            return row ? await replace(tx, row, input.update) as T | null : null;
          });
        },
        async updateMany(input: Parameters<DBAdapter["updateMany"]>[0]) {
          if (input.model !== "session") return current.updateMany(input);
          return atomic(async (tx, sql) => {
            await sql.$executeRaw`LOCK TABLE public."Session" IN SHARE ROW EXCLUSIVE MODE`;
            const targets: Row[] = [];
            for (let offset = 0; ; offset += 100) {
              const page = await tx.findMany<Row>({ model: "session", where: where(input.where),
                offset, limit: 100, sortBy: { field: "id", direction: "asc" } });
              targets.push(...page);
              if (page.length < 100) break;
            }
            let changed = 0;
            for (const row of targets) if (await replace(tx, row, input.update)) changed++;
            return changed;
          });
        },
        delete: input => current.delete(input.model === "session" ? { ...input, where: where(input.where)! } : input),
        deleteMany: input => current.deleteMany(input.model === "session" ? { ...input, where: where(input.where)! } : input),
        async consumeOne<T>(input: Parameters<DBAdapter["consumeOne"]>[0]): Promise<T | null> {
          if (input.model !== "session") return current.consumeOne<T>(input);
          return atomic(async tx => {
            const row = await tx.consumeOne<Row>({ ...input, where: where(input.where)! });
            return row ? decode(row, "session") as T : null;
          });
        },
        incrementOne: input => {
          // MQ has no numeric session fields. Do not transparently bypass the
          // authenticated envelope if a future plugin introduces such a field.
          if (input.model === "session") throw new SessionStorageError();
          return current.incrementOne(input);
        },
      };
    }
    return wrap(baseFor(db), db, false);
  };
}
