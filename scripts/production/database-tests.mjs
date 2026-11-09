import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { sessionFixture } from "../auth/session-fixture.mjs";
import { databaseUrl } from "../db/environment.mjs";
import { logPrivacySettings } from "../db/log-privacy.mjs";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "./database-config.mjs";
import { bootstrapDeploymentDatabase, migrateDeploymentDatabase, provisionDeploymentDatabase,
  auditRuntimeDatabase, initializeDeploymentSigningKeys } from "./database.mjs";

// Only the guarded local/CI test service may create this random staging target.
// Neither mq_test nor the development database is migrated, seeded or cleared.
export async function runProductionDatabaseTests({ beforeCleanup } = {}) {
  const base = new URL(await databaseUrl("test"));
  const control = new pg.Pool({ connectionString: base.href, max: 1, connectionTimeoutMillis: 5000 });
  let poolFailed = false;
  // pg's idle error includes a Client object. Retain only a failure flag so a
  // disconnected backend fails this run without an uncaught credential dump.
  control.on("error", () => { poolFailed = true; });
  const deploymentId = randomUUID(), name = `mq_staging_${deploymentId.replaceAll("-", "")}`;
  const config = validateDeploymentConfig({ version: 1, environment: "staging", deploymentId,
    database: { host: base.hostname, port: Number(base.port), name }, origin: "https://mq.localhost",
    media: { root: "/var/lib/mq/media", minFreeBytes: 268435456 } });
  const passwords = Object.fromEntries(LOGIN_IDENTITIES.map(key => [key, randomBytes(32).toString("hex")]));
  const keys = { publication: randomBytes(32).toString("hex"), moderation: randomBytes(32).toString("hex") };
  const pools = {}, urls = {}, checks = [];
  let result, failure;
  let created = false, initialized = false, stage = "test service identity";
  async function check(label, action) { stage = label; await action(); checks.push(label); console.log(`PASS production DB: ${label}`); }
  try {
    const identity = (await control.query("SELECT current_database() AS db,current_user AS actor,current_setting('server_version_num')::int AS version")).rows[0];
    assert.equal(identity.db, "mq_test"); assert.equal(identity.actor, "mq_test");
    assert.ok(identity.version >= 180000 && identity.version < 190000);
    await control.query(`CREATE DATABASE "${name}"`); created = true;
    for (const [key, value] of await logPrivacySettings()) {
      if (!["log_destination", "log_line_prefix"].includes(key)) await control.query(`ALTER DATABASE "${name}" SET ${key} TO '${value}'`);
    }
    for (const key of ["bootstrap", ...LOGIN_IDENTITIES]) {
      const url = new URL(base); url.pathname = `/${name}`;
      if (key !== "bootstrap") { url.username = config.roles[key]; url.password = passwords[key]; }
      urls[key] = url.href; pools[key] = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
      pools[key].on("error", () => { poolFailed = true; });
    }
    await check("one-time empty-target bootstrap and non-superuser 001-009 migration", async () => {
      await pools.bootstrap.query("CREATE FUNCTION public.synthetic_preexisting() RETURNS integer LANGUAGE SQL AS 'SELECT 1'");
      await assert.rejects(bootstrapDeploymentDatabase(pools.bootstrap, config, passwords));
      await pools.bootstrap.query("DROP FUNCTION public.synthetic_preexisting()");
      await bootstrapDeploymentDatabase(pools.bootstrap, config, passwords); initialized = true;
      await assert.rejects(bootstrapDeploymentDatabase(pools.bootstrap, config, passwords));
      await migrateDeploymentDatabase(urls.migration, config);
      await migrateDeploymentDatabase(urls.migration, config);
      const owner = (await pools.bootstrap.query(`SELECT r.rolname,r.rolsuper FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public._prisma_migrations'::regclass`)).rows[0];
      assert.equal(owner.rolname, config.roles.migration); assert.equal(owner.rolsuper, false);
      await assert.rejects(migrateDeploymentDatabase(urls.bootstrap, config));
    });
    await check("exact permissions and all 11 independent NOLOGIN owners", async () => {
      await provisionDeploymentDatabase(pools.bootstrap, config);
      await provisionDeploymentDatabase(pools.bootstrap, config);
      assert.deepEqual(await auditRuntimeDatabase(pools.runtime, config), { securityDefiners: 11, checkedIdentities: 15 });
      await assert.rejects(auditRuntimeDatabase(pools.bootstrap, config));
      await assert.rejects(auditRuntimeDatabase(pools.runtime, { ...config, deploymentId: randomUUID() }));
      await initializeDeploymentSigningKeys(pools.bootstrap, config, keys);
      await assert.rejects(initializeDeploymentSigningKeys(pools.bootstrap, config, keys));
    });
    const user = randomUUID(), account = randomUUID(), session = randomUUID();
    await check("grant and credential audit triggers keep durable events and invalidate sessions", async () => {
      await pools.maintenance.query(`INSERT INTO public."User"(id,name,email,username,"updatedAt") VALUES($1,'Synthetic administrator',$2,'synthetic_admin',CURRENT_TIMESTAMP)`, [user, `${randomUUID()}@accounts.invalid`]);
      await pools.maintenance.query(`INSERT INTO public."Account"(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$2,'credential',$2,'synthetic-password-hash',CURRENT_TIMESTAMP)`, [account, user]);
      await pools.maintenance.query(`INSERT INTO public."AdminGrant"("userId") VALUES($1)`, [user]);
      await sessionFixture.insert(pools.runtime, { id: session, userId: user });
      await pools.maintenance.query(`UPDATE public."Account" SET password='synthetic-replacement-hash',"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1`, [account]);
      assert.equal((await pools.runtime.query('SELECT count(*)::int AS n FROM public."Session"')).rows[0].n, 0);
      assert.equal((await pools.maintenance.query('SELECT "credentialVersion" FROM public."AdminGrant"')).rows[0].credentialVersion, 1);
      assert.deepEqual((await pools.maintenance.query('SELECT kind FROM public."AdminSecurityEvent" ORDER BY "eventAt",kind')).rows.map(row => row.kind).sort(), ["CREDENTIAL_RESET", "GRANTED"]);
      await sessionFixture.insert(pools.runtime, { id: session, userId: user });
      assert.equal((await pools.runtime.query("SELECT public.mq_lock_admin_access($1,$2) AS ok", [session, user])).rows[0].ok, true);
      assert.equal((await pools.runtime.query("SELECT public.mq_lock_admin_credentials($1) AS ok", [user])).rows[0].ok, true);
    });
    const story = randomUUID(), revision = randomUUID(), asset = randomUUID(), comment = randomUUID();
    await check("runtime media preparation and immutable revision projection", async () => {
      await pools.runtime.query('INSERT INTO public.media_asset(id) VALUES($1)', [asset]);
      await pools.runtime.query(`UPDATE public.media_asset SET state='READY',display_mime_type='image/webp',display_width=10,display_height=10,display_bytes=100,display_sha256=$2,
        thumbnail_mime_type='image/webp',thumbnail_width=10,thumbnail_height=10,thumbnail_bytes=100,thumbnail_sha256=$2 WHERE id=$1`, [asset, "a".repeat(64)]);
      const client = await pools.runtime.connect();
      try {
        await client.query("BEGIN");
        await client.query(`INSERT INTO public.story(id,slug,kind,draft_revision_id) VALUES($1,'synthetic-production-story','CAMPFIRE',$2)`, [story, revision]);
        await client.query('INSERT INTO public.story_revision(id,story_id,title,content) VALUES($1,$2,$3,$4)',
          [revision, story, "Synthetic staging story", JSON.stringify({ version: 2, blocks: [{ type: "paragraph", text: "Synthetic test content" }, { type: "image", assetId: asset, alt: "Synthetic image" }] })]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      assert.equal((await pools.runtime.query('SELECT count(*)::int AS n FROM public.story_revision_asset')).rows[0].n, 1);
    });
    async function signed(kind, fields) {
      const client = await pools.runtime.connect();
      try {
        await client.query("BEGIN");
        const xid = (await client.query("SELECT pg_current_xact_id()::text AS id")).rows[0].id;
        const payload = JSON.stringify([kind === "publication" ? "mq-publish-v1" : "mq-comment-moderation-v1", name, config.roles.runtime, xid, session, user, ...fields]);
        const signature = createHmac("sha256", Buffer.from(keys[kind], "hex")).update(payload).digest();
        await client.query(`SELECT public.${kind === "publication" ? "mq_apply_story_publication" : "mq_apply_comment_moderation"}($1,$2)`, [payload, signature]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    }
    await check("signed publication, like lock, comment guard/context and moderation", async () => {
      await signed("publication", ["publish", story, "0", revision, ""]);
      assert.equal((await pools.runtime.query("SELECT public.mq_lock_story_like_access($1,$2,$3) AS result", [session, user, story])).rows[0].result, "allowed");
      await pools.runtime.query("INSERT INTO public.story_like(user_id,story_id) VALUES($1,$2)", [user, story]);
      assert.equal((await pools.runtime.query("SELECT public.mq_lock_comment_context($1,$2,$3) AS result", [session, user, story])).rows[0].result, "PUBLISHED");
      await pools.runtime.query("INSERT INTO public.story_comment(id,story_id,user_id,body,submission_key_hash) VALUES($1,$2,$3,'Synthetic comment',$4)", [comment, story, user, randomBytes(32).toString("hex")]);
      await signed("moderation", ["approve", story, comment, "0"]);
      assert.equal((await pools.runtime.query("SELECT state FROM public.story_comment WHERE id=$1", [comment])).rows[0].state, "APPROVED");
    });
    await check("runtime rejects direct protected writes, keys, owners and schema privileges", async () => {
      for (const sql of [
        'UPDATE public."User" SET name=name WHERE false', 'UPDATE public."Account" SET password=password WHERE false',
        'UPDATE public."AdminGrant" SET version=version WHERE false', 'DELETE FROM public."AdminGrant" WHERE false',
        'SELECT * FROM public."AdminSecurityEvent"', 'UPDATE public.story SET state=state WHERE false',
        'UPDATE public.story SET published_revision_id=published_revision_id WHERE false', 'UPDATE public.story SET slot_id=slot_id WHERE false',
        'DELETE FROM public.story_revision WHERE false', 'DELETE FROM public.media_asset WHERE false',
        'UPDATE public.story_comment SET state=state WHERE false', 'SELECT * FROM mq_publish_private.signing_key',
        'SELECT * FROM mq_comment_private.moderation_key', 'SELECT * FROM public._prisma_migrations',
        'SELECT public.mq_admin_grant_audit()', 'CREATE TABLE public.denied(id integer)', 'CREATE TEMP TABLE denied(id integer)',
        `SET ROLE "${config.roles.owners.publication}"`,
      ]) await assert.rejects(pools.runtime.query(sql), error => error.code === "42501");
      await assert.rejects(pools.runtime.query("SELECT public.mq_apply_story_publication($1,$2)", ["[]", Buffer.alloc(32)]), error => error.code === "P7101");
      await assert.rejects(pools.runtime.query("SELECT public.mq_apply_comment_moderation($1,$2)", ["[]", Buffer.alloc(32)]), error => error.code === "P7201");
    });
    await check("offline identities remain separated and backup is read-only", async () => {
      assert.equal((await pools.backup.query("SELECT count(*)::int AS n FROM mq_publish_private.signing_key")).rows[0].n, 1);
      await assert.rejects(pools.backup.query('UPDATE public.story SET state=state WHERE false'), error => error.code === "42501");
      await assert.rejects(pools.maintenance.query('SELECT * FROM public.story'), error => error.code === "42501");
      await assert.rejects(pools.mediaMaintenance.query('SELECT * FROM public."User"'), error => error.code === "42501");
      const pending = randomUUID(); await pools.runtime.query('INSERT INTO public.media_asset(id) VALUES($1)', [pending]);
      await pools.mediaMaintenance.query("UPDATE public.media_asset SET state='DELETING' WHERE id=$1", [pending]);
      await pools.mediaMaintenance.query("UPDATE public.media_asset SET state='DELETED' WHERE id=$1", [pending]);
    });
    await check("startup fails closed on grants, owner login, role membership and PUBLIC execute drift", async () => {
      for (const [alter, restore] of [
        [`GRANT UPDATE(state) ON public.story TO "${config.roles.runtime}"`, `REVOKE UPDATE(state) ON public.story FROM "${config.roles.runtime}"`],
        [`ALTER ROLE "${config.roles.owners.publication}" LOGIN`, `ALTER ROLE "${config.roles.owners.publication}" NOLOGIN`],
        [`GRANT "${config.roles.owners.publication}" TO "${config.roles.runtime}" WITH INHERIT FALSE`, `REVOKE "${config.roles.owners.publication}" FROM "${config.roles.runtime}"`],
        ["GRANT EXECUTE ON FUNCTION public.mq_admin_grant_audit() TO PUBLIC", "REVOKE EXECUTE ON FUNCTION public.mq_admin_grant_audit() FROM PUBLIC"],
        [`ALTER ROLE "${config.roles.migration}" CREATEDB`, `ALTER ROLE "${config.roles.migration}" NOCREATEDB`],
      ]) {
        await pools.bootstrap.query(alter);
        try { await assert.rejects(auditRuntimeDatabase(pools.runtime, config)); }
        finally { await pools.bootstrap.query(restore); }
      }
      const outsider = `mq_audit_probe_${randomUUID().replaceAll("-", "")}`;
      await pools.bootstrap.query(`CREATE ROLE "${outsider}" NOLOGIN`);
      try {
        await pools.bootstrap.query(`GRANT "${config.roles.owners.publication}" TO "${outsider}" WITH INHERIT FALSE`);
        await assert.rejects(auditRuntimeDatabase(pools.runtime, config));
      } finally {
        await pools.bootstrap.query(`REVOKE "${config.roles.owners.publication}" FROM "${outsider}"`);
        await pools.bootstrap.query(`DROP ROLE "${outsider}"`);
      }
      assert.equal((await auditRuntimeDatabase(pools.runtime, config)).securityDefiners, 11);
    });
    // The regression hook delays a real socket shutdown or terminates an idle
    // backend. It is never enabled by the ordinary suite or a production CLI.
    if (beforeCleanup) await beforeCleanup({ control, pools, urls, config });
    result = { passed: checks.length, checks, serverVersion: identity.version };
  } catch (error) {
    failure = new Error(`PRODUCTION_DATABASE_TEST_FAILED: ${stage}`, { cause: error });
  }
  try {
    await Promise.all(Object.values(pools).map(pool => pool.end()));
    if (created) {
      // Pool.end() removes idle clients before their TCP close completes.
      // Wait for PostgreSQL to observe every target connection leaving;
      // FORCE here races pg's idle error listener and can dump a raw Client.
      const deadline = Date.now() + 5000;
      while ((await control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1", [name])).rows[0].n !== 0) {
        if (Date.now() >= deadline) throw new Error("PRODUCTION_DATABASE_DRAIN_TIMEOUT");
        await delay(25);
      }
      await control.query(`DROP DATABASE "${name}"`);
    }
    if (initialized) for (const role of [...LOGIN_IDENTITIES.map(key => config.roles[key]), ...Object.values(config.roles.owners)]) await control.query(`DROP ROLE "${role}"`);
  } catch (cause) { failure ??= new Error("PRODUCTION_DATABASE_CLEANUP_FAILED", { cause }); }
  finally { await control.end(); }
  if (poolFailed) failure ??= new Error("PRODUCTION_DATABASE_POOL_ERROR");
  if (failure) throw failure;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runProductionDatabaseTests())); }
  catch (error) {
    console.error(error.message);
    // Assertion messages and database object errors are withheld; no SQL or
    // generated connection string is written by this harness.
    console.error(`diagnostic=${error.cause?.cause?.code ?? error.cause?.code ?? "REJECTED"}`);
    process.exitCode = 1;
  }
}
