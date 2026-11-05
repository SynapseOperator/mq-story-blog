import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import { createMediaBackup, verifyMediaBackup } from "../media/backup.mjs";
import { restoreMediaBackup } from "../media/restore.mjs";
import { applyAdminDraftDatabasePrivileges } from "../admin-drafts/privileges.mjs";
import { applyMediaDatabasePrivileges } from "../media/privileges.mjs";
import { transport, privateHeaders } from "../media/upload-http-tests.mjs";
import { assertTemporaryTarget } from "../admin-drafts/test-support.mjs";
import { runPrisma } from "../db/prisma-command.mjs";
import { verifyDatabaseLogging } from "../db/log-privacy.mjs";

/** Native backup/restore of a populated 007 database. Keys and old sessions are
 * preserved as data, never treated as permission to enable a restored service. */
export async function runPublicationBackupTests({ source, controlURL, projectRoot, workspace, storage,
  runtimeRole, maintenanceRole, key, first, oldJar, origin, ca, secrets, rememberDatabase, withRestoredServer }) {
  assertTemporaryTarget(source.connectionString);
  const pool = new pg.Pool({ connectionString: source.connectionString, max: 1 });
  let restoredPool, runtime, passed = 0, stage = "source snapshot";
  const check = async (label, action) => { stage = label; await action(); passed++; console.log(`PASS publication backup: ${label}`); };
  const backups = join(workspace, "publication-backups"), restores = join(workspace, "publication-restores");
  const tools = { container: process.env.MQ_PG_TOOLS_CONTAINER
    || (process.platform === "win32" ? "mq-story-blog-postgres-test-1" : undefined) };
  const { request } = transport(origin, secrets, ca);
  let archive, result, restoredRuntime;
  try {
    await mkdir(backups, { mode: 0o700 }); await mkdir(restores, { mode: 0o700 });
    await verifyDatabaseLogging(pool);
    const sourceKey = (await pool.query("SELECT secret FROM mq_publish_private.signing_key WHERE id=1")).rows[0].secret;
    assert.ok(sourceKey.equals(Buffer.from(key, "hex")));
    const sourceSessions = (await pool.query('SELECT * FROM "Session" ORDER BY id')).rows;
    assert.ok(sourceSessions.length > 0);
    sourceSessions.forEach(session => secrets.add(session.token)); secrets.add(oldJar.cookie);
    const sourceGrant = (await pool.query('SELECT * FROM "AdminGrant" WHERE id=1')).rows[0];
    const sourceStory = (await pool.query("SELECT * FROM story WHERE id=$1", [first.id])).rows[0];
    const adminSession = sourceSessions.find(session => session.userId === sourceGrant.userId && session.expiresAt > new Date());
    assert.ok(adminSession && !sourceGrant.revokedAt);
    const readers = (await pool.query('SELECT id FROM "User" ORDER BY id')).rows;
    assert.ok(readers.length >= 2);
    for (const user of readers) await pool.query("INSERT INTO story_like(user_id,story_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [user.id, first.id]);
    const sourceLikes = (await pool.query("SELECT * FROM story_like ORDER BY story_id,user_id")).rows;
    assert.equal(sourceLikes.filter(like => like.story_id === first.id).length, readers.length);

    await check("full native archive contains nonempty private signing schema without exposing secrets in its manifest", async () => {
      archive = await createMediaBackup({ databaseURL: source.connectionString, expectedDatabase: source.name,
        storage, backupParent: backups, tools });
      await verifyMediaBackup(archive.directory);
      const manifest = await readFile(join(archive.directory, "manifest.json"), "utf8");
      assert.ok(!manifest.includes(key) && !manifest.includes(oldJar.cookie));
      for (const session of sourceSessions) assert.ok(!manifest.includes(session.token));
    });
    await check("restored 007 retains exact likes, key and sessions while PUBLIC privileges remain closed in all application schemas", async () => {
      result = await restoreMediaBackup({ directory: archive.directory, controlURL, restoreParent: restores, projectRoot, tools });
      rememberDatabase(result.database);
      restoredPool = new pg.Pool({ connectionString: result.databaseURL, max: 2 });
      await verifyDatabaseLogging(restoredPool);
      const restoredKey = (await restoredPool.query("SELECT secret FROM mq_publish_private.signing_key WHERE id=1")).rows[0].secret;
      assert.ok(restoredKey.equals(sourceKey));
      assert.deepEqual((await restoredPool.query('SELECT * FROM "Session" ORDER BY id')).rows, sourceSessions);
      assert.deepEqual((await restoredPool.query("SELECT * FROM story WHERE id=$1", [first.id])).rows[0], sourceStory);
      assert.deepEqual((await restoredPool.query("SELECT * FROM story_like ORDER BY story_id,user_id")).rows, sourceLikes);
      assert.ok((await restoredPool.query("SELECT to_regprocedure('public.mq_apply_story_publication(text,bytea)') IS NOT NULL AS present")).rows[0].present);
      const acl = (await restoredPool.query(`SELECT count(*)::int AS n FROM (
        SELECT a.grantee FROM pg_namespace ns,
          LATERAL aclexplode(coalesce(ns.nspacl,acldefault('n',ns.nspowner))) a
          WHERE ns.nspname !~ '^pg_' AND ns.nspname <> 'information_schema'
        UNION ALL SELECT a.grantee FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace,
          LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE ns.nspname !~ '^pg_' AND ns.nspname <> 'information_schema'
        UNION ALL SELECT a.grantee FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace,
          LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
          WHERE ns.nspname !~ '^pg_' AND ns.nspname <> 'information_schema' AND c.relkind IN ('r','p','S')
      ) grants WHERE grantee=0`)).rows[0].n;
      assert.equal(acl, 0);
      const configured = JSON.parse(await readFile(join(result.privateRoot, "RESTORE_COMPLETE.json"), "utf8"));
      assert.equal(configured.serviceEnabled, false); assert.equal(configured.privilegesRequireProvisioning, true);
      await runPrisma(["migrate", "status"], result.databaseURL);
      await runPrisma(["migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], result.databaseURL);
    });
    restoredRuntime = new URL(source.runtimeUrl); restoredRuntime.pathname = `/${result.database}`;
    await check("old runtime identity cannot connect to an unprovisioned restored database", async () => {
      const denied = new pg.Pool({ connectionString: restoredRuntime.href, max: 1, connectionTimeoutMillis: 5000 });
      try { await assert.rejects(denied.query("SELECT 1"), { code: "42501" }); } finally { await denied.end(); }
    });
    await check("ordinary application reprovisioning cannot publish or reveal restored keys", async () => {
      await applyAdminDraftDatabasePrivileges(restoredPool, { runtimeRole, maintenanceRole, expectedDatabase: result.database });
      await applyMediaDatabasePrivileges(restoredPool, { runtimeRole, expectedDatabase: result.database });
      await restoredPool.query(`GRANT SELECT ON public.story_like TO "${runtimeRole}"`);
      runtime = new pg.Pool({ connectionString: restoredRuntime.href, max: 1 });
      await assert.rejects(runtime.query("SELECT secret FROM mq_publish_private.signing_key"), { code: "42501" });
      for (const column of ["state", "published_revision_id", "slot_id"]) {
        await assert.rejects(runtime.query(`UPDATE story SET ${column}=${column} WHERE false`), { code: "42501" });
      }
      await assert.rejects(runtime.query("SELECT public.mq_apply_story_publication($1,$2)", ["[]", Buffer.alloc(32)]), { code: "42501" });
    });
    await check("old HTTPS cookie and matching old key cannot enable publication after only normal application provisioning", async () => {
      await withRestoredServer({ DATABASE_URL: restoredRuntime.href, MQ_MEDIA_TEST_ROOT: result.privateRoot }, async () => {
        const jar = { ...oldJar };
        const session = await request("/api/auth/get-session", { jar });
        assert.equal(session.status, 200); assert.ok(session.data.user);
        assert.equal((await request("/api/admin/status", { jar })).status, 200);
        const anonymousLikes = await request(`/api/stories/${first.id}/likes`);
        assert.equal(anonymousLikes.status, 200); assert.deepEqual(anonymousLikes.data, { count: readers.length, liked: false }); privateHeaders(anonymousLikes);
        const personalLikes = await request(`/api/stories/${first.id}/likes`, { jar });
        assert.equal(personalLikes.status, 200); assert.deepEqual(personalLikes.data, { count: readers.length, liked: true }); privateHeaders(personalLikes);
        const denied = await request(`/api/admin/stories/${first.id}/withdraw`, {
          method: "POST", jar, body: { expectedVersion: sourceStory.version },
        });
        assert.equal(denied.status, 503); privateHeaders(denied);
        assert.deepEqual((await restoredPool.query("SELECT * FROM story WHERE id=$1", [first.id])).rows[0], sourceStory);
      });
    });
    await check("even an accidental EXECUTE grant cannot bypass the restored function-owner gate with a valid old-key proof", async () => {
      await restoredPool.query(`GRANT EXECUTE ON FUNCTION public.mq_apply_story_publication(text,bytea) TO "${runtimeRole}"`);
      const tx = await runtime.connect();
      try {
        await tx.query("BEGIN");
        const context = (await tx.query("SELECT current_database() AS db,session_user AS actor,pg_current_xact_id()::text AS xid")).rows[0];
        const payload = JSON.stringify(["mq-publish-v1", context.db, context.actor, context.xid,
          adminSession.id, sourceGrant.userId, "withdraw", first.id, String(sourceStory.version),
          sourceStory.published_revision_id, sourceStory.slot_id ?? ""]);
        const signature = createHmac("sha256", Buffer.from(key, "hex")).update(payload).digest();
        await assert.rejects(tx.query("SELECT public.mq_apply_story_publication($1,$2)", [payload, signature]), { code: "P7102" });
      } finally {
        await tx.query("ROLLBACK"); tx.release();
        await restoredPool.query(`REVOKE ALL ON FUNCTION public.mq_apply_story_publication(text,bytea) FROM "${runtimeRole}"`);
      }
      assert.deepEqual((await restoredPool.query("SELECT * FROM story WHERE id=$1", [first.id])).rows[0], sourceStory);
    });
    return { passed, total: 6 };
  } catch (error) { error.publishingStage = `backup: ${stage}`; throw error; }
  finally { await Promise.allSettled([pool.end(), restoredPool?.end(), runtime?.end()]); }
}
