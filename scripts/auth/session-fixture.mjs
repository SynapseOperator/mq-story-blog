import { randomBytes, randomUUID } from "node:crypto";
import { createSessionCodec } from "../../src/server/auth/session-storage.ts";

// Synthetic fixtures only. The integration entry points already verify their
// random database target. Never import this module into the application.
export function createSessionFixture(key = randomBytes(32).toString("hex")) {
  const codec = createSessionCodec(key);
  function row(values) {
    const now = new Date();
    return codec.seal({ id: randomUUID(), token: randomBytes(16).toString("hex"),
      createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 3_600_000),
      ipAddress: null, userAgent: null, ...values });
  }
  async function insert(pool, values) {
    const value = row(values);
    await pool.query(`INSERT INTO public."Session"
      (id,"userId",token,"tokenCiphertext","expiresAt","createdAt","updatedAt","ipAddress","userAgent")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [value.id, value.userId, value.token,
      value.tokenCiphertext, value.expiresAt.toISOString(), value.createdAt.toISOString(), value.updatedAt.toISOString(), value.ipAddress, value.userAgent]);
    return value;
  }
  async function expire(pool, userId) {
    // Prisma DateTime maps to timestamp without time zone; pg's default parser
    // otherwise interprets these UTC values in the Windows host timezone.
    const rows = (await pool.query(`SELECT *, "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",
      "createdAt" AT TIME ZONE 'UTC' AS "createdAt", "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
      FROM "Session" WHERE "userId"=$1`, [userId])).rows;
    for (const value of rows) {
      // This is a legitimate expiry fixture, not SQL tampering with signed
      // fields. Separate security tests deliberately corrupt rows without sealing.
      const next = codec.seal({ ...codec.open(value), expiresAt: new Date(Date.now() - 60_000), updatedAt: new Date() });
      await pool.query('UPDATE "Session" SET "expiresAt"=$2,"updatedAt"=$3,"tokenCiphertext"=$4 WHERE id=$1',
        [next.id, next.expiresAt.toISOString(), next.updatedAt.toISOString(), next.tokenCiphertext]);
    }
  }
  return { key, row, insert, expire };
}

// One key per integration coordinator; all of its HTTP/HTTPS workers receive
// this same key explicitly. It is not written to disk or printed.
export const sessionFixture = createSessionFixture();
