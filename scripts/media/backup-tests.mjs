import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { databaseUrl } from "../db/environment.mjs";
import { runPrisma } from "../db/prisma-command.mjs";
import { configureTemporaryDatabaseLogging } from "../db/log-privacy.mjs";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { createStoryService } from "../../src/server/stories/service.ts";
import { initializeAdmin } from "../../src/server/admin/maintenance.ts";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";
import { createMediaBackup, verifyMediaBackup } from "./backup.mjs";
import { restoreMediaBackup } from "./restore.mjs";
import { digest } from "./backup-files.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Optional callback supplies real production HTTP checks after least-privilege
 * reprovisioning. All fixtures and archives stay in this run's random DB/dirs. */
export async function runBackupTests({ verifyRestored } = {}) {
  const base = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: base, max: 1 });
  const name = `mq_test_isolated_${randomUUID().replaceAll("-", "")}`;
  const sourceURL = new URL(base); sourceURL.pathname = `/${name}`;
  const databases = [], tools = { container: process.env.MQ_PG_TOOLS_CONTAINER || (process.platform === "win32" ? "mq-story-blog-postgres-test-1" : undefined) };
  let workspace, pool, client, passed = 0, stage = "create isolated backup source", failure;
  async function check(label, operation) { stage = label; await operation(); passed++; console.log(`PASS backup: ${label}`); }
  try {
    const identity = (await control.query("SELECT current_database() AS db,current_user AS actor")).rows[0];
    assert.equal(identity.db, "mq_test"); assert.equal(identity.actor, "mq_test");
    await control.query(`CREATE DATABASE "${name}"`); databases.push(name);
    await configureTemporaryDatabaseLogging(control, name);
    await runPrisma(["migrate", "deploy"], sourceURL.href);
    pool = new pg.Pool({ connectionString: sourceURL.href, max: 5 });
    client = createAuthDatabaseClient(sourceURL.href);
    workspace = await mkdtemp(join(tmpdir(), "mq-backup-test-"));
    const development = join(workspace, "private-development"), test = join(workspace, "private-source"), backups = join(workspace, "backups"), restores = join(workspace, "restores");
    for (const path of [development, test, backups, restores]) await mkdir(path, { mode: 0o700 });
    const storage = { projectRoot, roots: { development, test }, environment: "test", maxVariantBytes: 4 * 1024 * 1024 };
    const store = await createLocalMediaStore(storage), assets = [];
    for (const color of ["#335577", "#773355", "#557733"]) {
      const bytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).webp().toBuffer();
      const id = randomUUID();
      const row = (await pool.query("INSERT INTO media_asset(id) VALUES($1) RETURNING storage_key", [id])).rows[0];
      for (const variant of ["display", "thumbnail"]) await store.write(row.storage_key, variant, bytes);
      await pool.query(`UPDATE media_asset SET state='READY',display_mime_type='image/webp',display_width=48,display_height=32,
        display_bytes=$2,display_sha256=$3,thumbnail_mime_type='image/webp',thumbnail_width=48,thumbnail_height=32,
        thumbnail_bytes=$2,thumbnail_sha256=$3 WHERE id=$1`, [id, bytes.length, digest(bytes)]);
      assets.push({ id, key: row.storage_key, bytes });
    }
    const stories = createStoryService(client);
    const content = assetId => ({ version: 2, blocks: [{ type: "paragraph", text: "合成恢复演练文章" }, { type: "image", assetId, alt: "合成恢复测试图片" }] });
    const published = await stories.createDraft({ kind: "STAR", slug: `restore-public-${randomUUID()}`, slotId: "star-1", title: "合成公开恢复测试", content: content(assets[0].id) });
    await stories.publish({ storyId: published.id, expectedVersion: published.version });
    await stories.createDraft({ kind: "STAR", slug: `restore-private-${randomUUID()}`, title: "合成私人草稿恢复测试", content: content(assets[1].id) });
    const userId = randomUUID(), token = randomUUID();
    await client.user.create({ data: { id: userId, name: "Synthetic backup account", username: `backup_${randomUUID().slice(0,8)}`, email: `${randomUUID()}@accounts.invalid` } });
    await client.session.create({ data: { id: randomUUID(), userId, token, expiresAt: new Date(Date.now() + 3_600_000) } });
    const admin = { username: `restore_${randomUUID().slice(0,8)}`, password: `MqRestore!${randomUUID()}` };
    await initializeAdmin(client, admin);
    const options = { databaseURL: sourceURL.href, expectedDatabase: name, storage, backupParent: backups, tools };
    let successful;

    await check("PENDING and DELETING require explicit recovery before a consistent backup", async () => {
      const id = randomUUID(); await pool.query("INSERT INTO media_asset(id) VALUES($1)", [id]);
      await assert.rejects(createMediaBackup(options), { code: "BACKUP_BUSY" });
      await pool.query("UPDATE media_asset SET state='DELETING' WHERE id=$1", [id]);
      await assert.rejects(createMediaBackup(options), { code: "BACKUP_BUSY" });
      await pool.query("UPDATE media_asset SET state='DELETED' WHERE id=$1", [id]);
    });
    await check("native pg_dump, same snapshot and READY image bytes form a complete private archive", async () => {
      successful = await createMediaBackup(options);
      assert.equal(successful.assets, 3); assert.equal(successful.files, 6);
      const manifest = await verifyMediaBackup(successful.directory);
      assert.equal(manifest.inventory.length, 4);
      assert.ok(!(await readFile(join(successful.directory, "manifest.json"), "utf8")).includes(token));
    });
    await check("media SHARE lock blocks a concurrent delete until the database/file snapshot finishes", async () => {
      const blocker = await pool.connect(), writer = await pool.connect();
      let saving, deleting;
      try {
        await blocker.query("BEGIN; LOCK TABLE database_probe IN ACCESS EXCLUSIVE MODE");
        saving = createMediaBackup(options); saving.catch(() => {});
        let backupPid;
        for (let n = 0; n < 200; n++) {
          const locked = (await pool.query(`SELECT pid FROM pg_locks WHERE relation='media_asset'::regclass AND mode='ShareLock' AND granted`)).rows;
          if (locked.length) { backupPid = locked[0].pid; break; } await delay(15);
        }
        assert.ok(backupPid, "Observe the real backup SHARE lock");
        await writer.query("BEGIN");
        const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        deleting = writer.query("UPDATE media_asset SET state='DELETING' WHERE id=$1", [assets[2].id]); deleting.catch(() => {});
        let waited = false;
        for (let n = 0; n < 200; n++) {
          const wait = (await pool.query("SELECT $1=ANY(pg_blocking_pids($2)) AS waiting", [backupPid, writerPid])).rows[0];
          if (wait.waiting) { waited = true; break; } await delay(15);
        }
        assert.ok(waited, "Delete must wait for backup, not pass a pre-read condition");
        await blocker.query("ROLLBACK");
        const result = await saving; await deleting; await writer.query("ROLLBACK");
        assert.equal((await verifyMediaBackup(result.directory)).files, 6);
      } finally {
        await blocker.query("ROLLBACK"); await writer.query("ROLLBACK");
        await saving?.catch(() => {}); await deleting?.catch(() => {});
        blocker.release(); writer.release();
      }
    });
    await check("missing or corrupt source files leave no complete backup marker", async () => {
      const path = join(test, assets[0].key, "display.webp"), held = `${path}.held`;
      await rename(path, held);
      try { await assert.rejects(createMediaBackup(options), { code: "BACKUP_FAILED" }); }
      finally { await rename(held, path); }
      const directories = await readdir(backups);
      assert.ok((await Promise.all(directories.map(async item => (await readdir(join(backups, item))).includes("COMPLETE.json")))).includes(false));
    });
    await check("missing bytes, image corruption and manifest tampering are detected", async () => {
      const path = join(successful.directory, "media", assets[0].key, "display.webp"), held = `${path}.held`;
      await rename(path, held);
      try { await assert.rejects(verifyMediaBackup(successful.directory)); } finally { await rename(held, path); }
      await writeFile(path, Buffer.from("damaged synthetic image"));
      try { await assert.rejects(verifyMediaBackup(successful.directory)); } finally { await writeFile(path, assets[0].bytes); }
      const manifestPath = join(successful.directory, "manifest.json"), bytes = await readFile(manifestPath);
      await writeFile(manifestPath, Buffer.from("tampered manifest"));
      try { await assert.rejects(verifyMediaBackup(successful.directory)); } finally { await writeFile(manifestPath, bytes); }
    });
    await check("native isolated restore preserves revisions, files and synthetic raw-session data; PUBLIC has no function access", async () => {
      const result = await restoreMediaBackup({ directory: successful.directory, controlURL: base, restoreParent: restores, projectRoot, tools });
      databases.push(result.database);
      const restored = new pg.Pool({ connectionString: result.databaseURL, max: 1 });
      try {
        assert.equal((await restored.query('SELECT token FROM "Session" WHERE "userId"=$1', [userId])).rows[0].token, token);
        assert.equal((await restored.query("SELECT count(*)::int AS n FROM story_revision_asset")).rows[0].n, 2);
        assert.equal((await restored.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace,
          LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE ns.nspname='public' AND a.grantee=0 AND a.privilege_type='EXECUTE'`)).rows[0].n, 0);
        for (const asset of assets) for (const variant of ["display", "thumbnail"]) {
          assert.deepEqual(await readFile(join(result.privateRoot, asset.key, `${variant}.webp`)), asset.bytes);
        }
      } finally { await restored.end(); }
      if (verifyRestored) await verifyRestored({ ...result, publicStoryId: published.id, publicSlug: published.slug,
        publicAssetId: assets[0].id, privateAssetId: assets[1].id, expectedPublicBytes: assets[0].bytes,
        expectedPrivateBytes: assets[1].bytes, admin });
    });
    await check("self-consistent changed manifest is rejected against restored PostgreSQL inventory", async () => {
      const manifestPath = join(successful.directory, "manifest.json"), completePath = join(successful.directory, "COMPLETE.json");
      const original = await readFile(manifestPath), completeBytes = await readFile(completePath);
      const changed = JSON.parse(original); changed.inventory.find(row => row.state === "DELETED").id = randomUUID();
      const changedBytes = Buffer.from(JSON.stringify(changed));
      const complete = JSON.parse(completeBytes); complete.manifestSha256 = digest(changedBytes);
      await writeFile(manifestPath, changedBytes); await writeFile(completePath, JSON.stringify(complete));
      try {
        await verifyMediaBackup(successful.directory);
        await assert.rejects(restoreMediaBackup({ directory: successful.directory, controlURL: base, restoreParent: restores, projectRoot, tools }), { code: "RESTORE_FAILED" });
      } finally { await writeFile(manifestPath, original); await writeFile(completePath, completeBytes); }
    });
  } catch (error) { failure = error; }
  finally {
    await client?.$disconnect(); await pool?.end();
    for (const name of databases.reverse()) {
      assert.match(name, /^mq_test_(isolated|admin)_[a-f0-9]{32}$/);
      try { await control.query(`DROP DATABASE "${name}"`); } catch (error) { failure ??= error; }
    }
    await control.end();
    if (workspace) {
      const actual = await realpath(workspace), parent = await realpath(tmpdir());
      assert.equal(dirname(actual), parent); assert.equal(actual, resolve(workspace)); assert.ok(basename(actual).startsWith("mq-backup-test-"));
      await rm(actual, { recursive: true, force: false });
    }
  }
  if (failure) { const safe = new Error("BACKUP_TEST_FAILED"); safe.stage = `${stage}${failure.phase ? ` / ${failure.phase}` : ""}`; safe.code = /^[A-Z0-9_]{1,40}$/.test(failure.code ?? "") ? failure.code : "ERROR"; throw safe; }
  return { passed, total: 7 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runBackupTests(); console.log(`Backup PostgreSQL/filesystem: ${result.passed}/${result.total} checks passed`); }
  catch (error) { console.error(`Backup integration FAILED at ${error.stage ?? "setup"} (${error.code ?? "ERROR"}; private details withheld)`); process.exitCode = 1; }
}
