import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, URL } from "node:url";
import pg from "pg";
import { databaseUrl } from "../db/environment.mjs";
import { logPrivacySettings } from "../db/log-privacy.mjs";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "./database-config.mjs";
import { bootstrapDeploymentDatabase, migrateDeploymentDatabase, provisionDeploymentDatabase,
  initializeDeploymentSigningKeys, auditRuntimeDatabase } from "./database.mjs";
import { MAINTENANCE_LOCK, pauseDeploymentWriters, resumeDeploymentWriters, rotateDeploymentPasswords,
  rotateDeploymentSigningKeys, revokeDeploymentSessions } from "./rotation.mjs";

export async function runRotationTests() {
  const base = new URL(await databaseUrl("test"));
  const id = randomUUID(), name = `mq_staging_${id.replaceAll("-", "")}`;
  const config = validateDeploymentConfig({ version: 1, environment: "staging", deploymentId: id,
    database: { host: base.hostname, port: Number(base.port), name }, origin: "https://mq.localhost",
    media: { root: "/var/lib/mq/media", minFreeBytes: 268435456 } });
  const passwords = Object.fromEntries(LOGIN_IDENTITIES.map(key => [key, randomBytes(32).toString("hex")]));
  const replacements = Object.fromEntries(LOGIN_IDENTITIES.map(key => [key, randomBytes(32).toString("hex")]));
  const keys = { publication: randomBytes(32).toString("hex"), moderation: randomBytes(32).toString("hex") };
  const nextKeys = { previousPublication: keys.publication, previousModeration: keys.moderation,
    publication: randomBytes(32).toString("hex"), moderation: randomBytes(32).toString("hex") };
  let failed = false, created = false, bootstrapped = false, stage = "setup", failure;
  const pools = [], checks = [];
  const urlFor = (key, password = passwords[key]) => {
    const url = new URL(base); url.pathname = `/${name}`;
    if (key !== "bootstrap") { url.username = config.roles[key]; url.password = password; }
    return url.href;
  };
  const pool = connectionString => {
    const value = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
    value.on("error", () => { failed = true; }); pools.push(value); return value;
  };
  const control = pool(base.href), operator = pool(urlFor("bootstrap"));
  const check = async (label, action) => { stage = label; await action(); checks.push(label); console.log(`PASS rotation: ${label}`); };
  async function drain() {
    const deadline = Date.now() + 5000;
    while ((await operator.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=ANY($1)",
      [LOGIN_IDENTITIES.map(key => config.roles[key])])).rows[0].n !== 0) {
      assert.ok(Date.now() < deadline); await delay(25);
    }
  }
  const user = randomUUID(), session = randomUUID(), story = randomUUID(), revision = randomUUID(), comment = randomUUID();
  async function seedSession(target, sessionId) {
    await target.query('INSERT INTO public."Session"(id,"userId",token,"expiresAt","updatedAt") VALUES($1,$2,$3,CURRENT_TIMESTAMP+interval \'1 hour\',CURRENT_TIMESTAMP)',
      [sessionId, user, randomBytes(24).toString("hex")]);
  }
  async function sign(target, kind, secret, sessionId, fields) {
    const client = await target.connect();
    try {
      await client.query("BEGIN");
      const tx = (await client.query("SELECT pg_current_xact_id()::text AS id")).rows[0].id;
      const payload = JSON.stringify([kind === "publication" ? "mq-publish-v1" : "mq-comment-moderation-v1",
        name, config.roles.runtime, tx, sessionId, user, ...fields]);
      const proof = createHmac("sha256", Buffer.from(secret, "hex")).update(payload).digest();
      const result = await client.query(`SELECT public.${kind === "publication" ? "mq_apply_story_publication" : "mq_apply_comment_moderation"}($1,$2)`, [payload, proof]);
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  try {
    const identity = (await control.query("SELECT current_database() AS db,current_user AS actor")).rows[0];
    assert.deepEqual(identity, { db: "mq_test", actor: "mq_test" });
    await control.query(`CREATE DATABASE "${name}"`); created = true;
    for (const [key, value] of await logPrivacySettings()) if (!["log_destination", "log_line_prefix"].includes(key)) {
      await control.query(`ALTER DATABASE "${name}" SET ${key} TO '${value}'`);
    }
    await bootstrapDeploymentDatabase(operator, config, passwords); bootstrapped = true;
    await migrateDeploymentDatabase(urlFor("migration"), config);
    await provisionDeploymentDatabase(operator, config);
    await initializeDeploymentSigningKeys(operator, config, keys);
    await operator.query('INSERT INTO public."User"(id,name,email,username,"updatedAt") VALUES($1,\'Synthetic rotation administrator\',$2,\'synthetic_rotation\',CURRENT_TIMESTAMP)',
      [user, `${randomUUID()}@accounts.invalid`]);
    await operator.query('INSERT INTO public."AdminGrant"("userId") VALUES($1)', [user]);
    await seedSession(operator, session);
    await operator.query("BEGIN");
    await operator.query("INSERT INTO public.story(id,slug,kind,draft_revision_id) VALUES($1,'synthetic-rotation-story','CAMPFIRE',$2)", [story, revision]);
    await operator.query("INSERT INTO public.story_revision(id,story_id,title,content) VALUES($1,$2,'Synthetic rotation story',$3)",
      [revision, story, JSON.stringify({ version: 1, blocks: [{ type: "paragraph", text: "Synthetic data only" }] })]);
    await operator.query("COMMIT");
    await check("wrong target and runtime cannot operate the maintenance gate", async () => {
      const runtime = pool(urlFor("runtime"));
      await assert.rejects(pauseDeploymentWriters(runtime, config));
      await runtime.end();
      await assert.rejects(pauseDeploymentWriters(operator, { ...config, deploymentId: randomUUID() }));
      assert.equal((await operator.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1) AND rolcanlogin", [LOGIN_IDENTITIES.map(key => config.roles[key])])).rows[0].n, 5);
    });
    await check("busy writer causes refusal with durable NOLOGIN gate, no forced termination", async () => {
      const runtime = pool(urlFor("runtime")); await runtime.query("SELECT 1");
      await assert.rejects(pauseDeploymentWriters(operator, config, { drainTimeoutMs: 0 }));
      assert.equal((await runtime.query("SELECT 1 AS n")).rows[0].n, 1);
      const blocked = pool(urlFor("runtime")); await assert.rejects(blocked.query("SELECT 1"), error => error.code === "28000"); await blocked.end();
      await runtime.end(); await drain();
      assert.equal((await pauseDeploymentWriters(operator, config)).paused, true);
      const backup = pool(urlFor("backup")); assert.equal((await backup.query('SELECT count(*)::int AS n FROM public."User"')).rows[0].n, 1); await backup.end(); await drain();
    });
    await check("maintenance lock prevents concurrent resume and password updates", async () => {
      const lock = pool(urlFor("bootstrap"));
      await lock.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [MAINTENANCE_LOCK]);
      await assert.rejects(resumeDeploymentWriters(operator, config));
      await assert.rejects(rotateDeploymentPasswords(operator, config, replacements));
      await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [MAINTENANCE_LOCK]); await lock.end();
    });
    await check("signing rotation checks old keys and rolls back both key writes and session deletion", async () => {
      await assert.rejects(rotateDeploymentSigningKeys(operator, config, { ...nextKeys, previousModeration: randomBytes(32).toString("hex") }));
      assert.equal((await operator.query('SELECT count(*)::int AS n FROM public."Session"')).rows[0].n, 1);
      // Force a real database error after the first key update. This temporary
      // test-only constraint is only in this random synthetic database.
      await operator.query(`ALTER TABLE mq_comment_private.moderation_key ADD CONSTRAINT synthetic_rotation_failure CHECK(secret=decode('${keys.moderation}','hex'))`);
      await assert.rejects(rotateDeploymentSigningKeys(operator, config, nextKeys));
      assert.equal((await operator.query("SELECT encode(secret,'hex') AS value FROM mq_publish_private.signing_key")).rows[0].value, keys.publication);
      assert.equal((await operator.query('SELECT count(*)::int AS n FROM public."Session"')).rows[0].n, 1);
      await operator.query("ALTER TABLE mq_comment_private.moderation_key DROP CONSTRAINT synthetic_rotation_failure");
      assert.equal((await rotateDeploymentSigningKeys(operator, config, nextKeys)).revokedSessions, 1);
      await assert.rejects(rotateDeploymentSigningKeys(operator, config, nextKeys));
      assert.equal((await revokeDeploymentSessions(operator, config)).revokedSessions, 0);
    });
    await check("all five passwords change atomically and role permissions remain unchanged", async () => {
      const backup = pool(urlFor("backup")); await backup.query("SELECT 1");
      await assert.rejects(rotateDeploymentPasswords(operator, config, replacements));
      await backup.end(); await drain();
      assert.equal((await rotateDeploymentPasswords(operator, config, replacements)).passwordsRotated, 5);
      await resumeDeploymentWriters(operator, config);
      for (const key of LOGIN_IDENTITIES) {
        const old = pool(urlFor(key));
        // CI's legacy PG service may use trust. Password rejection is proven
        // with SCRAM in the production container lab, never called a pass here.
        const authMethod = process.env.CI === "true" ? "trust" : "scram";
        if (authMethod === "scram") await assert.rejects(old.query("SELECT 1"), error => error.code === "28P01");
        await old.end();
        const current = pool(urlFor(key, replacements[key])); assert.equal((await current.query("SELECT current_user AS actor")).rows[0].actor, config.roles[key]);
        if (key === "runtime") assert.equal((await auditRuntimeDatabase(current, config)).securityDefiners, 11);
        await current.end();
      }
    });
    await check("old signing proofs and revoked session fail, new session and both new keys work", async () => {
      const runtime = pool(urlFor("runtime", replacements.runtime));
      await assert.rejects(sign(runtime, "publication", nextKeys.publication, session, ["publish", story, "0", revision, ""]));
      const newSession = randomUUID(); await seedSession(runtime, newSession);
      await assert.rejects(sign(runtime, "publication", keys.publication, newSession, ["publish", story, "0", revision, ""]));
      await sign(runtime, "publication", nextKeys.publication, newSession, ["publish", story, "0", revision, ""]);
      await runtime.query("INSERT INTO public.story_comment(id,story_id,user_id,body,submission_key_hash) VALUES($1,$2,$3,'Synthetic rotation comment',$4)", [comment, story, user, randomBytes(32).toString("hex")]);
      await assert.rejects(sign(runtime, "moderation", keys.moderation, newSession, ["approve", story, comment, "0"]));
      await sign(runtime, "moderation", nextKeys.moderation, newSession, ["approve", story, comment, "0"]);
      assert.equal((await runtime.query("SELECT state FROM public.story_comment WHERE id=$1", [comment])).rows[0].state, "APPROVED");
      await runtime.end();
    });
  } catch (cause) { failure = new Error(`PRODUCTION_ROTATION_TEST_FAILED: ${stage}`, { cause }); }
  finally {
    for (const value of pools) if (value !== control && !value.ending) await value.end();
    try {
      if (created) {
        const deadline = Date.now() + 5000;
        while ((await control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1", [name])).rows[0].n !== 0) {
          assert.ok(Date.now() < deadline); await delay(25);
        }
        await control.query(`DROP DATABASE "${name}"`);
      }
      if (bootstrapped) for (const role of [...LOGIN_IDENTITIES.map(key => config.roles[key]), ...Object.values(config.roles.owners)]) await control.query(`DROP ROLE "${role}"`);
    } catch { failure ??= new Error("PRODUCTION_ROTATION_CLEANUP_FAILED"); }
    await control.end();
  }
  if (failed) failure ??= new Error("PRODUCTION_ROTATION_POOL_FAILED");
  if (failure) throw failure;
  return { checks, passed: checks.length, passwordRejection: process.env.CI === "true" ? "requires SCRAM container lab" : "SCRAM verified" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runRotationTests())); }
  catch (error) { console.error(error.message); console.error(`diagnostic=${error.cause?.cause?.code ?? error.cause?.code ?? "REJECTED"}`); process.exitCode = 1; }
}
