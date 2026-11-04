import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { settleUploadFailure } from "../../src/server/media/http.ts";

/** Exercise the actual recovery transaction operation, with two restricted
 * database connections and a real observed row-lock wait. Authentication is
 * separately covered by the production HTTP suite; this tests the uncertain
 * finalize outcome at the database boundary, without a fake Prisma client. */
export async function runMediaRecoveryTests({ connectionString, runtimeUrl }) {
  const ownerTarget = new URL(connectionString), runtimeTarget = new URL(runtimeUrl);
  assert.match(ownerTarget.pathname, /^\/mq_test_admin_[a-f0-9]{32}$/);
  assert.equal(ownerTarget.username, "mq_test");
  for (const field of ["protocol", "hostname", "port", "pathname"]) assert.equal(ownerTarget[field], runtimeTarget[field]);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(ownerTarget.hostname));
  assert.match(runtimeTarget.username, /^mq_admin_rt_[a-f0-9]{32}$/);
  const owner = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  const finalizerPool = new pg.Pool({ connectionString: runtimeUrl, max: 1, connectionTimeoutMillis: 5000 });
  const recovery = createAuthDatabaseClient(runtimeUrl);
  let passed = 0, stage = "initialize recovery race";
  try {
    for (const commit of [true, false]) {
      stage = commit ? "late finalize commit remains READY and cannot request file cleanup" : "rolled-back finalize becomes FAILED and permits cleanup";
      const id = randomUUID();
      await finalizerPool.query("INSERT INTO media_asset(id) VALUES($1)", [id]);
      const finalizer = await finalizerPool.connect();
      let waiting;
      try {
        await finalizer.query("BEGIN");
        await finalizer.query("SET LOCAL statement_timeout='5s'");
        const blocker = (await finalizer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await finalizer.query(`UPDATE media_asset SET state='READY',display_mime_type='image/webp',display_width=20,display_height=10,
          display_bytes=40,display_sha256=repeat('a',64),thumbnail_mime_type='image/webp',thumbnail_width=20,thumbnail_height=10,
          thumbnail_bytes=40,thumbnail_sha256=repeat('b',64) WHERE id=$1`, [id]);
        let waiter;
        waiting = recovery.$transaction(async tx => {
          waiter = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
          return settleUploadFailure(tx, id);
        });
        waiting.catch(() => {});
        let observed = false;
        for (let n = 0; n < 150; n++) {
          if (waiter !== undefined) {
            const locks = (await owner.query(`SELECT count(*)::int AS n FROM pg_locks
              WHERE pid=$1 AND NOT granted AND $2=ANY(pg_blocking_pids(pid))`, [waiter, blocker])).rows[0].n;
            if (locks > 0) { observed = true; break; }
          }
          await delay(10);
        }
        assert.ok(observed, "The real recovery update must wait for the original finalize transaction");
        await finalizer.query(commit ? "COMMIT" : "ROLLBACK");
        const result = await waiting;
        const stored = (await finalizer.query("SELECT state,display_sha256 FROM media_asset WHERE id=$1", [id])).rows[0];
        if (commit) {
          assert.equal(result.failed, false); assert.equal(result.asset.id, id); assert.equal(result.asset.state, "READY");
          assert.equal(stored.state, "READY"); assert.equal(stored.display_sha256, "a".repeat(64));
        } else {
          assert.deepEqual(result, { failed: true, asset: null });
          assert.equal(stored.state, "FAILED"); assert.equal(stored.display_sha256, null);
        }
        passed += 1; console.log(`PASS media recovery: ${stage}`);
      } finally {
        await finalizer.query("ROLLBACK"); finalizer.release();
        if (waiting) await waiting.catch(() => {});
      }
    }
  } catch (error) {
    const safe = new Error("MEDIA_RECOVERY_TEST_FAILED"); safe.stage = stage;
    safe.code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR"; throw safe;
  } finally { await Promise.allSettled([owner.end(), finalizerPool.end(), recovery.$disconnect()]); }
  return { passed, total: 2 };
}
