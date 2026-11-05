import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import pg from "pg";
import { databaseUrl } from "../db/environment.mjs";
import { runPrisma } from "../db/prisma-command.mjs";
import { configureTemporaryDatabaseLogging, verifyDatabaseLogging } from "../db/log-privacy.mjs";
import { provisionMediaTestRuntime, runMediaDatabaseTests, MEDIA_MIGRATION } from "./database-tests.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const historical = ["202610230001_database_foundation", "202610230002_story_lifecycle",
  "202610230003_username_auth", "202610250004_admin_authorization"];
const publicationMigration = "202611040006_story_publication";
const likesMigration = "202611040007_story_likes";
const checksum = value => createHash("sha256").update(value).digest("hex");
let stage = "validate isolated PostgreSQL test target";

async function main() {
  const base = await databaseUrl("test");
  const control = new pg.Pool({ connectionString: base, max: 1, connectionTimeoutMillis: 5000 });
  const token = randomUUID().replaceAll("-", "");
  const runtimeRole = `mq_media_rt_${token}`;
  const password = randomBytes(32).toString("hex");
  const databases = [];
  let roleCreated = false, temporaryMigrations, failure;
  async function createDatabase(prefix) {
    const name = `mq_test_${prefix}_${randomUUID().replaceAll("-", "")}`;
    assert.match(name, /^mq_test_(it|isolated)_[a-f0-9]{32}$/);
    await control.query(`CREATE DATABASE "${name}"`);
    databases.push(name);
    await configureTemporaryDatabaseLogging(control, name);
    const url = new URL(base); url.pathname = `/${name}`;
    return url.href;
  }
  async function withPool(connectionString, action) {
    const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
    try { return await action(pool); } finally { await pool.end(); }
  }
  async function migrationHistory(connectionString) {
    return withPool(connectionString, async pool => (await pool.query(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
    )).rows);
  }
  try {
    const identity = (await control.query("SELECT current_database() AS db, current_user AS usr, current_setting('server_version_num') AS version")).rows[0];
    assert.equal(identity.db, "mq_test"); assert.equal(identity.usr, "mq_test");
    assert.ok(Number(identity.version) >= 180000 && Number(identity.version) < 190000);
    console.log(`PostgreSQL server_version_num=${identity.version}`);
    stage = "create this run's least-privilege identity without logging credentials";
    await control.query("SET log_statement='none'; SET log_min_error_statement='panic'; SET log_error_verbosity='terse'; SET log_parameter_max_length_on_error=0");
    assert.match(runtimeRole, /^mq_media_rt_[a-f0-9]{32}$/); assert.match(password, /^[a-f0-9]{64}$/);
    await control.query(`CREATE ROLE "${runtimeRole}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    roleCreated = true;

    stage = "apply all migrations from an isolated empty database";
    const fresh = await createDatabase("it");
    await withPool(fresh, async pool => {
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
      await verifyDatabaseLogging(pool);
    });
    await runPrisma(["migrate", "deploy"], fresh);
    const firstHistory = await migrationHistory(fresh);
    assert.deepEqual(firstHistory.map(row => row.migration_name), [...historical, MEDIA_MIGRATION, publicationMigration, likesMigration]);
    assert.ok(firstHistory.every(row => row.finished_at && row.rolled_back_at === null));
    await runPrisma(["migrate", "deploy"], fresh);
    await runPrisma(["migrate", "status"], fresh);
    await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], fresh);
    assert.deepEqual(await migrationHistory(fresh), firstHistory);
    console.log("PASS media migrations: empty 001 -> 007, repeated deploy, status and schema drift");

    stage = "construct a byte-identical temporary 001 through 004 migration tree";
    temporaryMigrations = await mkdtemp(join(tmpdir(), "mq-media-migrations-"));
    const migrationDirectory = join(temporaryMigrations, "migrations");
    await mkdir(migrationDirectory);
    const originalChecksums = new Map();
    for (const name of historical) {
      const source = join(root, "prisma", "migrations", name, "migration.sql");
      const targetDirectory = join(migrationDirectory, name);
      await mkdir(targetDirectory);
      await copyFile(source, join(targetDirectory, "migration.sql"), 1);
      const original = await readFile(source);
      originalChecksums.set(name, checksum(original));
      assert.deepEqual(await readFile(join(targetDirectory, "migration.sql")), original);
    }
    await copyFile(join(root, "prisma", "migrations", "migration_lock.toml"), join(migrationDirectory, "migration_lock.toml"), 1);
    const config = join(temporaryMigrations, "prisma.config.ts");
    // No credential is written: Prisma receives the URL only in its environment.
    await writeFile(config, `export default { schema: ${JSON.stringify(join(root, "prisma", "schema.prisma"))}, migrations: { path: ${JSON.stringify(migrationDirectory)} }, datasource: { url: process.env.DATABASE_URL } };\n`, { flag: "wx" });
    const upgrade = await createDatabase("isolated");
    await runPrisma(["migrate", "deploy", "--config", config], upgrade);
    const beforeUpgrade = await migrationHistory(upgrade);
    assert.deepEqual(beforeUpgrade.map(row => row.migration_name), historical);
    const legacyId = randomUUID(), legacyRevisionId = randomUUID();
    const legacyContent = { version: 1, blocks: [{ type: "paragraph", text: "Synthetic legacy migration fixture" },
      { type: "image", src: "/scene/night-sky.webp", alt: "Synthetic legacy image" }] };
    await withPool(upgrade, async pool => {
      await pool.query("BEGIN");
      try {
        await pool.query("INSERT INTO story(id,slug,kind,draft_revision_id) VALUES ($1,$2,'STAR',$3)",
          [legacyId, `legacy-${randomUUID()}`, legacyRevisionId]);
        await pool.query("INSERT INTO story_revision(id,story_id,title,content) VALUES ($1,$2,$3,$4::jsonb)",
          [legacyRevisionId, legacyId, "Synthetic pre-005 draft", JSON.stringify(legacyContent)]);
        await pool.query("COMMIT");
      } catch (error) { await pool.query("ROLLBACK"); throw error; }
    });
    stage = "upgrade a real 004 database without rewriting historical migrations or v1 content";
    const legacyBefore = await withPool(upgrade, async pool => (await pool.query("SELECT * FROM story_revision WHERE id=$1", [legacyRevisionId])).rows[0]);
    // Stop at 005 first: preserve the original media migration upgrade proof
    // instead of silently turning it into a direct 004 -> latest deployment.
    await mkdir(join(migrationDirectory, MEDIA_MIGRATION));
    const mediaSource = join(root, "prisma", "migrations", MEDIA_MIGRATION, "migration.sql");
    await copyFile(mediaSource, join(migrationDirectory, MEDIA_MIGRATION, "migration.sql"), 1);
    originalChecksums.set(MEDIA_MIGRATION, checksum(await readFile(mediaSource)));
    await runPrisma(["migrate", "deploy", "--config", config], upgrade);
    const afterUpgrade = await migrationHistory(upgrade);
    assert.deepEqual(afterUpgrade.map(row => row.migration_name), [...historical, MEDIA_MIGRATION]);
    assert.deepEqual(afterUpgrade.slice(0, 4), beforeUpgrade);
    for (const name of historical) {
      assert.equal(checksum(await readFile(join(root, "prisma", "migrations", name, "migration.sql"))), originalChecksums.get(name));
      assert.equal(afterUpgrade.find(row => row.migration_name === name).checksum, originalChecksums.get(name));
    }
    await withPool(upgrade, async pool => {
      assert.deepEqual((await pool.query("SELECT * FROM story_revision WHERE id=$1", [legacyRevisionId])).rows[0], legacyBefore);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM media_asset")).rows[0].n, 0);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM story_revision_asset")).rows[0].n, 0);
    });
    console.log("PASS media migrations: real 004 -> 005 preserves v1 bytes and all historical migration checksums");

    stage = "upgrade a populated 005 database and preserve public v2 revision references";
    const assetId = randomUUID(), managedStoryId = randomUUID(), managedRevisionId = randomUUID();
    const managedContent = { version: 2, blocks: [{ type: "paragraph", text: "Synthetic pre-006 public version" },
      { type: "image", assetId, alt: "Synthetic managed image" }] };
    await withPool(upgrade, async pool => {
      await pool.query("BEGIN");
      try {
        await pool.query("INSERT INTO media_asset(id) VALUES ($1)", [assetId]);
        await pool.query(`UPDATE media_asset SET state='READY',display_mime_type='image/webp',display_width=800,display_height=600,
          display_bytes=1000,display_sha256=repeat('a',64),thumbnail_mime_type='image/webp',thumbnail_width=400,thumbnail_height=300,
          thumbnail_bytes=300,thumbnail_sha256=repeat('b',64) WHERE id=$1`, [assetId]);
        await pool.query("INSERT INTO story(id,slug,kind,draft_revision_id,slot_id) VALUES ($1,$2,'STAR',$3,'star-1')",
          [managedStoryId, `managed-${randomUUID()}`, managedRevisionId]);
        await pool.query("INSERT INTO story_revision(id,story_id,title,content) VALUES ($1,$2,$3,$4::jsonb)",
          [managedRevisionId, managedStoryId, "Synthetic pre-006 published story", JSON.stringify(managedContent)]);
        await pool.query("UPDATE story SET state='PUBLISHED',published_revision_id=draft_revision_id,version=version+1 WHERE id=$1", [managedStoryId]);
        await pool.query("COMMIT");
      } catch (error) { await pool.query("ROLLBACK"); throw error; }
    });
    const managedSnapshot = async () => withPool(upgrade, async pool => ({
      story: (await pool.query("SELECT * FROM story WHERE id=$1", [managedStoryId])).rows,
      revision: (await pool.query("SELECT * FROM story_revision WHERE id=$1", [managedRevisionId])).rows,
      asset: (await pool.query("SELECT * FROM media_asset WHERE id=$1", [assetId])).rows,
      references: (await pool.query("SELECT * FROM story_revision_asset WHERE revision_id=$1", [managedRevisionId])).rows,
    }));
    const managedBefore = await managedSnapshot();
    assert.equal(managedBefore.references.length, 1);
    // Preserve the existing 005 -> 006 proof before testing the new migration.
    await mkdir(join(migrationDirectory, publicationMigration));
    const publicationSource = join(root, "prisma", "migrations", publicationMigration, "migration.sql");
    await copyFile(publicationSource, join(migrationDirectory, publicationMigration, "migration.sql"), 1);
    originalChecksums.set(publicationMigration, checksum(await readFile(publicationSource)));
    await runPrisma(["migrate", "deploy", "--config", config], upgrade);
    await runPrisma(["migrate", "status", "--config", config], upgrade);
    const publicationHistory = await migrationHistory(upgrade);
    assert.deepEqual(publicationHistory.map(row => row.migration_name), [...historical, MEDIA_MIGRATION, publicationMigration]);
    assert.deepEqual(publicationHistory.slice(0, 5), afterUpgrade);
    for (const [name, original] of originalChecksums) {
      assert.equal(checksum(await readFile(join(root, "prisma", "migrations", name, "migration.sql"))), original);
      assert.equal(publicationHistory.find(row => row.migration_name === name).checksum, original);
    }
    assert.deepEqual(await managedSnapshot(), managedBefore);
    await withPool(upgrade, async pool => {
      assert.deepEqual((await pool.query("SELECT * FROM story_revision WHERE id=$1", [legacyRevisionId])).rows[0], legacyBefore);
    });
    await runPrisma(["migrate", "deploy", "--config", config], upgrade);
    assert.deepEqual(await migrationHistory(upgrade), publicationHistory);
    console.log("PASS publication migration: real 005 -> 006 preserves v1/v2, public state, media references and historical checksums");

    stage = "upgrade a populated 006 database to 007 without changing existing stories, media or authentication";
    const priorUser = randomUUID(), priorSession = randomUUID();
    await withPool(upgrade, async pool => {
      await pool.query('INSERT INTO "User"(id,name,email,username,"updatedAt") VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP)',
        [priorUser, "Synthetic pre-007 reader", `${priorUser}@accounts.invalid`, `legacy_${priorUser.replaceAll("-", "").slice(0, 16)}`]);
      await pool.query('INSERT INTO "Session"(id,"userId",token,"expiresAt","updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP+INTERVAL \'1 hour\',CURRENT_TIMESTAMP)',
        [priorSession, priorUser, randomUUID()]);
    });
    const authSnapshot = () => withPool(upgrade, async pool => ({
      users: (await pool.query('SELECT * FROM "User" ORDER BY id')).rows,
      sessions: (await pool.query('SELECT * FROM "Session" ORDER BY id')).rows,
    }));
    const authBefore = await authSnapshot();
    await runPrisma(["migrate", "deploy"], upgrade);
    await runPrisma(["migrate", "status"], upgrade);
    await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], upgrade);
    const likesHistory = await migrationHistory(upgrade);
    assert.deepEqual(likesHistory.map(row => row.migration_name), [...historical, MEDIA_MIGRATION, publicationMigration, likesMigration]);
    assert.deepEqual(likesHistory.slice(0, 6), publicationHistory);
    for (const [name, original] of originalChecksums) {
      assert.equal(checksum(await readFile(join(root, "prisma", "migrations", name, "migration.sql"))), original);
      assert.equal(likesHistory.find(row => row.migration_name === name).checksum, original);
    }
    assert.deepEqual(await managedSnapshot(), managedBefore); assert.deepEqual(await authSnapshot(), authBefore);
    await withPool(upgrade, async pool => {
      assert.deepEqual((await pool.query("SELECT * FROM story_revision WHERE id=$1", [legacyRevisionId])).rows[0], legacyBefore);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM story_like")).rows[0].n, 0);
      await pool.query("INSERT INTO story_like(user_id,story_id) VALUES($1,$2)", [priorUser, managedStoryId]);
    });
    await runPrisma(["migrate", "deploy"], upgrade);
    assert.deepEqual(await migrationHistory(upgrade), likesHistory);
    await withPool(upgrade, async pool => assert.equal((await pool.query("SELECT count(*)::int AS n FROM story_like")).rows[0].n, 1));
    console.log("PASS likes migration: real 006 -> 007 preserves content, media, users, sessions and 001 -> 006 checksums; repeat deploy retains likes with no drift");

    stage = "provision runtime only in this run's disposable database";
    await withPool(fresh, pool => provisionMediaTestRuntime(pool, runtimeRole, new URL(fresh).pathname.slice(1)));
    const runtime = new URL(fresh); runtime.username = runtimeRole; runtime.password = password;
    stage = "real media constraints, restricted identity, concurrency and public isolation";
    const result = await runMediaDatabaseTests({ connectionString: fresh, runtimeUrl: runtime.href });
    assert.equal(result.passed, result.total);
    console.log(`Media PostgreSQL integration: ${result.passed}/${result.total} checks passed`);
    await withPool(upgrade, async pool => assert.deepEqual((await pool.query("SELECT id FROM media_asset")).rows, [{ id: assetId }]));
    console.log("PASS media databases: foundation fixtures cannot cross the isolated upgrade database");
  } catch (error) { failure = error; }
  finally {
    for (const name of databases) {
      try { await control.query(`DROP DATABASE "${name}"`); } catch (error) { failure ??= error; }
    }
    if (roleCreated) { try { await control.query(`DROP ROLE "${runtimeRole}"`); } catch (error) { failure ??= error; } }
    try { await control.end(); } catch (error) { failure ??= error; }
    if (temporaryMigrations) {
      try {
        const verified = await realpath(temporaryMigrations), parent = await realpath(tmpdir());
        assert.equal(dirname(verified), parent);
        assert.ok(basename(verified).startsWith("mq-media-migrations-"));
        assert.equal(resolve(temporaryMigrations), verified);
        await rm(verified, { recursive: true, force: false });
      } catch (error) { failure ??= error; }
    }
  }
  if (failure) throw failure;
  console.log("PASS media cleanup: removed only this invocation's temporary databases, role and migration copy");
}

try { await main(); }
catch (error) {
  const code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR";
  console.error(`Media integration FAILED at: ${error.mediaStage ?? stage} (${code}; raw details and credentials withheld)`);
  process.exitCode = 1;
}
