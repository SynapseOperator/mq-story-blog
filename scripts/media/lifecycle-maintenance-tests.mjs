import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";
import { diagnoseMediaAsset, recoverMediaAsset, parseMediaMaintenanceArguments } from "./maintenance.mjs";
import { verifyMediaMaintenanceConnection } from "./maintenance-privileges.mjs";

/** Targeted offline recovery, never a storage-root sweep. Every row/file is a
 * synthetic fixture created by this test in the enclosing disposable instance. */
export async function runMediaLifecycleMaintenanceTests({ connectionString, maintenanceUrl, storageRoot, projectRoot }) {
  const target = new URL(connectionString), operator = new URL(maintenanceUrl);
  assert.match(target.pathname, /^\/mq_test_admin_[a-f0-9]{32}$/);
  assert.equal(target.username, "mq_test"); assert.match(operator.username, /^mq_media_mt_[a-f0-9]{32}$/);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.equal(operator.host, target.host); assert.equal(operator.pathname, target.pathname);
  const owner = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  const maintenancePool = new pg.Pool({ connectionString: maintenanceUrl, max: 1, connectionTimeoutMillis: 5000 });
  const db = createAuthDatabaseClient(maintenanceUrl);
  const store = await createLocalMediaStore({ projectRoot,
    roots: { development: join(dirname(storageRoot), "maintenance-unused-development"), test: storageRoot },
    environment: "test", maxVariantBytes: 4 * 1024 * 1024 });
  const image = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#406080" } }).webp().toBuffer();
  const digest = createHash("sha256").update(image).digest("hex");
  let stage = "initialize offline media recovery", passed = 0;
  async function run(name, action) { stage = name; await action(); passed++; console.log(`PASS media maintenance: ${name}`); }
  async function fixture(state = "FAILED", expired = false) {
    const id = randomUUID();
    await owner.query(`INSERT INTO media_asset(id,created_at) VALUES($1,clock_timestamp()-$2::interval)`, [id, expired ? "3 minutes" : "0 seconds"]);
    if (state === "READY") await owner.query(`UPDATE media_asset SET state='READY',display_mime_type='image/webp',display_width=20,display_height=10,
      display_bytes=$2,display_sha256=$3,thumbnail_mime_type='image/webp',thumbnail_width=20,thumbnail_height=10,
      thumbnail_bytes=$2,thumbnail_sha256=$3 WHERE id=$1`, [id, image.length, digest]);
    else if (state !== "PENDING") await owner.query("UPDATE media_asset SET state=$2::\"MediaAssetState\" WHERE id=$1", [id, state]);
    const key = (await owner.query("SELECT storage_key FROM media_asset WHERE id=$1", [id])).rows[0].storage_key;
    await store.write(key, "display", image); await store.write(key, "thumbnail", image);
    return { id, key };
  }
  const recover = (id, options = { offlineConfirmed: true }) => recoverMediaAsset(db, store, id, options);
  async function state(id) { return (await owner.query("SELECT state FROM media_asset WHERE id=$1", [id])).rows[0].state; }
  try {
    await run("maintenance arguments accept only one explicit database and controlled asset identity", async () => {
      const id = randomUUID(), name = target.pathname.slice(1);
      const parsed = parseMediaMaintenanceArguments(["--operation", "diagnose", "--database", name, "--asset-id", id]);
      assert.equal(parsed.operation, "diagnose"); assert.equal(parsed.database, name); assert.equal(parsed.id, id);
      assert.equal(await verifyMediaMaintenanceConnection(maintenancePool, name), operator.username);
      await assert.rejects(verifyMediaMaintenanceConnection(owner, name), /MEDIA_MAINTENANCE_IDENTITY_REJECTED/);
      for (const args of [[], ["--operation", "sweep", "--database", name, "--asset-id", id],
        ["--operation", "recover", "--database", name, "--asset-id", "../outside"],
        ["--operation", "recover", "--database", name, "--asset-id", id, "--storage-key", randomUUID()],
        ["--operation", "recover", "--database", name, "--asset-id", id, "--all"]]) {
        assert.throws(() => parseMediaMaintenanceArguments(args));
      }
    });
    await run("diagnostics detect missing and tampered bytes without exposing paths or keys", async () => {
      const item = await fixture("READY");
      const healthy = await diagnoseMediaAsset(db, store, item.id);
      assert.equal(healthy.id, item.id); assert.equal(healthy.state, "READY");
      assert.equal(healthy.display, "ok"); assert.equal(healthy.thumbnail, "ok");
      await unlink(join(storageRoot, item.key, "thumbnail.webp"));
      assert.equal((await diagnoseMediaAsset(db, store, item.id)).thumbnail, "missing");
      await store.write(item.key, "thumbnail", image);
      const corrupt = Buffer.from(image); corrupt[corrupt.length - 1] ^= 1;
      await writeFile(join(storageRoot, item.key, "display.webp"), corrupt, { flag: "r+" });
      const report = await diagnoseMediaAsset(db, store, item.id);
      assert.equal(report.display, "mismatch");
      assert.ok(!JSON.stringify(report).includes(item.key)); assert.ok(!JSON.stringify(report).includes(storageRoot));
      assert.equal(await state(item.id), "READY");
      await writeFile(join(storageRoot, item.key, "display.webp"), image, { flag: "r+" });
    });
    await run("offline recovery never removes READY images even when unreferenced", async () => {
      const item = await fixture("READY");
      await assert.rejects(recover(item.id), error => error.status === 409);
      assert.equal(await state(item.id), "READY"); assert.deepEqual(await store.read(item.key, "display"), image);
      await assert.rejects(recover(item.id, { offlineConfirmed: false }));
    });
    await run("FAILED variants and known pending fragments are cleaned only for the selected asset", async () => {
      const item = await fixture(), neighbor = await fixture("READY");
      const fragment = join(storageRoot, item.key, `.pending-${randomUUID()}`);
      await writeFile(fragment, image.subarray(0, 12), { flag: "wx", mode: 0o600 });
      await recover(item.id); assert.equal(await state(item.id), "DELETED");
      assert.ok(!(await readdir(storageRoot)).includes(item.key));
      assert.deepEqual(await store.read(neighbor.key, "display"), image);
      await recover(item.id); assert.equal(await state(item.id), "DELETED");
    });
    await run("a recent PENDING reservation is refused and an expired one can recover offline", async () => {
      const recent = await fixture("PENDING"), expired = await fixture("PENDING", true);
      await assert.rejects(recover(recent.id), error => error.status === 409);
      assert.equal(await state(recent.id), "PENDING"); assert.deepEqual(await store.read(recent.key, "display"), image);
      await recover(expired.id); assert.equal(await state(expired.id), "DELETED");
      assert.ok(!(await readdir(storageRoot)).includes(expired.key));
      // Stop the synthetic reservation explicitly, then remove its own files so
      // later backup tests do not mistake it for a live upload process.
      await owner.query("UPDATE media_asset SET state='FAILED' WHERE id=$1", [recent.id]); await recover(recent.id);
    });
    await run("unknown files fail closed and partial DELETING removal resumes without siblings", async () => {
      const item = await fixture("DELETING"), sentinel = join(storageRoot, item.key, "unknown.txt");
      await writeFile(sentinel, "synthetic sentinel", { flag: "wx", mode: 0o600 });
      await assert.rejects(recover(item.id));
      assert.equal(await state(item.id), "DELETING"); assert.equal(await readFile(sentinel, "utf8"), "synthetic sentinel");
      assert.deepEqual(await store.read(item.key, "thumbnail"), image);
      await unlink(sentinel); await unlink(join(storageRoot, item.key, "display.webp"));
      await recover(item.id); assert.equal(await state(item.id), "DELETED");
      assert.ok(!(await readdir(storageRoot)).includes(item.key));
    });
    await run("an inaccessible record and metadata mutation are rejected under maintenance identity", async () => {
      assert.equal((await diagnoseMediaAsset(db, store, randomUUID())).state, "NOT_FOUND");
      const item = await fixture("READY");
      await assert.rejects(db.$executeRaw`UPDATE public.media_asset SET storage_key=${randomUUID()}::uuid WHERE id=${item.id}::uuid`);
      await assert.rejects(db.$executeRaw`UPDATE public.media_asset SET display_width=99 WHERE id=${item.id}::uuid`);
      await assert.rejects(db.$executeRaw`DELETE FROM public.story_revision_asset WHERE false`);
      await assert.rejects(db.$executeRaw`UPDATE public.story SET state='PUBLISHED' WHERE false`);
      await assert.rejects(db.$executeRaw`UPDATE public."AdminGrant" SET version=version+1 WHERE false`);
      assert.equal(await state(item.id), "READY");
    });
  } catch (error) {
    const safe = new Error("MEDIA_MAINTENANCE_TEST_FAILED"); safe.stage = stage;
    safe.code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR"; throw safe;
  } finally { await Promise.allSettled([owner.end(), maintenancePool.end(), db.$disconnect()]); }
  return { passed, total: 7 };
}
