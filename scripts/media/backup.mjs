import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import sharp from "sharp";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";
import { backupError, createPrivateChild, digest, uuid, verifyPrivateDirectory, verifyPrivateFile, writePrivate } from "./backup-files.mjs";
import { localBackupTarget, runPgBackupTool } from "./backup-pg.mjs";

export const mediaInventorySql = `SELECT id,storage_key,state,
  display_mime_type,display_width,display_height,display_bytes,display_sha256,
  thumbnail_mime_type,thumbnail_width,thumbnail_height,thumbnail_bytes,thumbnail_sha256
  FROM public.media_asset ORDER BY id`;
const variants = ["display", "thumbnail"];
const maxDumpBytes = 512 * 1024 * 1024;

export async function fileDigest(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxDumpBytes) throw backupError("BACKUP_TOO_LARGE");
    hash.update(chunk);
  }
  return { byteLength: bytes, sha256: hash.digest("hex") };
}

async function verifyImage(bytes, row, variant) {
  if (bytes.length !== row[`${variant}_bytes`] || digest(bytes) !== row[`${variant}_sha256`]) {
    throw backupError("BACKUP_INTEGRITY_FAILED");
  }
  const actual = await sharp(bytes, { limitInputPixels: 24_000_000, failOn: "error" }).metadata();
  if (actual.format !== "webp" || (actual.pages ?? 1) !== 1 || actual.width !== row[`${variant}_width`]
    || actual.height !== row[`${variant}_height`]) throw backupError("BACKUP_INTEGRITY_FAILED");
}

/** Same exported snapshot for native pg_dump and the asset inventory. SHARE
 * blocks media INSERT/UPDATE, so no READY -> DELETING can commit before copying
 * completes. PENDING/DELETING are refused, not guessed to be safe. This is a
 * bounded maintenance transaction, deliberately separate from withAdmin. */
export async function createMediaBackup({ databaseURL, expectedDatabase, storage, backupParent, tools = {} }) {
  const target = localBackupTarget(databaseURL, expectedDatabase);
  const store = await createLocalMediaStore(storage);
  const pool = new pg.Pool({ connectionString: databaseURL, max: 1, connectionTimeoutMillis: 5000 });
  let connection, directory, phase = "snapshot";
  try {
    connection = await pool.connect();
    await connection.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await connection.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='300s'; SET LOCAL idle_in_transaction_session_timeout='300s'");
    await connection.query("LOCK TABLE public.media_asset IN SHARE MODE");
    const identity = (await connection.query(`SELECT current_database() AS db,current_setting('server_version_num')::int AS version,
      (SELECT rolsuper OR oid=(SELECT datdba FROM pg_database WHERE datname=current_database())
      FROM pg_roles WHERE rolname=current_user) AS maintenance`)).rows[0];
    if (identity.db !== expectedDatabase || !identity.maintenance || identity.version < 180000 || identity.version >= 190000) {
      throw backupError("BACKUP_IDENTITY_REJECTED");
    }
    const inventory = (await connection.query(mediaInventorySql)).rows;
    if (inventory.some(row => row.state === "PENDING" || row.state === "DELETING")) throw backupError("BACKUP_BUSY");
    const snapshot = (await connection.query("SELECT pg_export_snapshot() AS snapshot")).rows[0].snapshot;
    phase = "private-directory";
    directory = await createPrivateChild(backupParent, "mq-backup-");
    await mkdir(join(directory, "media"), { mode: 0o700 });
    const ready = inventory.filter(row => row.state === "READY");
    phase = "image-copy";
    for (const row of ready) {
      if (!uuid.test(row.id) || !uuid.test(row.storage_key)) throw backupError("BACKUP_INTEGRITY_FAILED");
      await mkdir(join(directory, "media", row.storage_key), { mode: 0o700 });
      for (const variant of variants) {
        const bytes = await store.read(row.storage_key, variant);
        await verifyImage(bytes, row, variant);
        await writePrivate(join(directory, "media", row.storage_key, `${variant}.webp`), bytes);
      }
    }
    const dump = join(directory, "database.dump");
    phase = "native-dump";
    await runPgBackupTool("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--snapshot=${snapshot}`], target, { ...tools, output: dump });
    const database = await fileDigest(dump);
    phase = "complete-marker";
    if (!database.byteLength) throw backupError("BACKUP_INTEGRITY_FAILED");
    const manifest = { format: "mq-private-backup-v1", postgresMajor: 18, createdAt: new Date().toISOString(),
      sourceDatabase: expectedDatabase, database, inventory, files: ready.length * 2 };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    await writePrivate(join(directory, "manifest.json"), manifestBytes);
    // A failed commit, process crash or image check leaves no completion marker.
    await connection.query("COMMIT");
    await writePrivate(join(directory, "COMPLETE.json"), Buffer.from(JSON.stringify({ format: manifest.format,
      manifestSha256: digest(manifestBytes), databaseSha256: database.sha256 })));
    return { directory, assets: ready.length, files: manifest.files };
  } catch (error) {
    if (connection) await connection.query("ROLLBACK").catch(() => {});
    throw Object.assign(backupError(error.code === "BACKUP_BUSY" ? "BACKUP_BUSY" : "BACKUP_FAILED"), { phase });
  } finally { connection?.release(); await pool.end(); }
}

/** A checksum is accidental-corruption detection, not a signature. Only verify
 * an operator-controlled backup; an attacker able to rewrite dump AND manifest
 * is outside this unsigned format's trust boundary. Never restore untrusted SQL. */
export async function verifyMediaBackup(directory) {
  await verifyPrivateDirectory(directory);
  const complete = JSON.parse((await verifyPrivateFile(join(directory, "COMPLETE.json"), 4096)).toString("utf8"));
  const manifestBytes = await verifyPrivateFile(join(directory, "manifest.json"), 4 * 1024 * 1024);
  if (digest(manifestBytes) !== complete.manifestSha256) throw backupError("BACKUP_INTEGRITY_FAILED");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.format !== "mq-private-backup-v1" || complete.format !== manifest.format || manifest.postgresMajor !== 18
    || !Array.isArray(manifest.inventory) || manifest.inventory.length > 10000) throw backupError("BACKUP_INTEGRITY_FAILED");
  const dump = join(directory, "database.dump");
  await verifyPrivateFile(dump, maxDumpBytes, { read: false });
  const actual = await fileDigest(dump);
  if (actual.byteLength !== manifest.database.byteLength || actual.sha256 !== manifest.database.sha256
    || actual.sha256 !== complete.databaseSha256) throw backupError("BACKUP_INTEGRITY_FAILED");
  const ids = new Set(), keys = new Set(), ready = [];
  for (const row of manifest.inventory) {
    if (!uuid.test(row.id) || !uuid.test(row.storage_key) || ids.has(row.id) || keys.has(row.storage_key)
      || !["READY", "FAILED", "DELETED"].includes(row.state)) throw backupError("BACKUP_INTEGRITY_FAILED");
    ids.add(row.id); keys.add(row.storage_key);
    if (row.state === "READY") ready.push(row);
  }
  if (manifest.files !== ready.length * 2) throw backupError("BACKUP_INTEGRITY_FAILED");
  const expectedRoot = ["COMPLETE.json", "database.dump", "manifest.json", "media"].sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expectedRoot)) throw backupError("BACKUP_INTEGRITY_FAILED");
  await verifyPrivateDirectory(join(directory, "media"));
  if (JSON.stringify((await readdir(join(directory, "media"))).sort()) !== JSON.stringify(ready.map(row => row.storage_key).sort())) {
    throw backupError("BACKUP_INTEGRITY_FAILED");
  }
  for (const row of ready) {
    const object = join(directory, "media", row.storage_key);
    await verifyPrivateDirectory(object);
    if (JSON.stringify((await readdir(object)).sort()) !== JSON.stringify(["display.webp", "thumbnail.webp"])) throw backupError("BACKUP_INTEGRITY_FAILED");
    for (const variant of variants) {
      const bytes = await verifyPrivateFile(join(object, `${variant}.webp`), 4 * 1024 * 1024);
      await verifyImage(bytes, row, variant);
    }
  }
  return manifest;
}

// Restore uses this after pg_restore to reject a manipulated manifest even when
// its own checksum was updated. Database contents are the independent inventory.
export async function compareRestoredInventory(pool, manifest) {
  const actual = (await pool.query(mediaInventorySql)).rows;
  if (JSON.stringify(actual) !== JSON.stringify(manifest.inventory)) throw backupError("BACKUP_DATABASE_MISMATCH");
  const invalid = (await pool.query(`SELECT count(*)::int AS n FROM public.story_revision_asset ref
    LEFT JOIN public.media_asset asset ON asset.id=ref.asset_id AND asset.state='READY'
    WHERE asset.id IS NULL`)).rows[0].n;
  if (invalid !== 0) throw backupError("BACKUP_DATABASE_MISMATCH");
  return actual.filter(row => row.state === "READY");
}
