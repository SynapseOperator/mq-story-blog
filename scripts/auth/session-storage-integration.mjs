import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { betterAuth } from "better-auth";
import { toNodeHandler } from "better-auth/node";
import { username } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { protectedPrismaAdapter } from "../../src/server/auth/session-adapter.ts";
import { createSessionCodec } from "../../src/server/auth/session-storage.ts";
import { hashPassword, verifyPassword } from "../../src/server/auth/password.ts";
import { databaseUrl } from "../db/environment.mjs";
import { configureTemporaryDatabaseLogging } from "../db/log-privacy.mjs";
import { runPrisma } from "../db/prisma-command.mjs";
import { prepareLegacySessionDatabase } from "./legacy-session-fixture.mjs";
const { fetch } = globalThis;

// Framework endpoints are exposed only by this loopback test server. MQ's four
// public authentication paths remain unchanged. Never print responses or errors.
let stage = "isolated target", passed = 0;
const tokenOf = cookie => decodeURIComponent(cookie.split("=").slice(1).join("=")).split(".")[0];
const signedCookie = (token, secret) => `mq_protected.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", secret).update(token).digest("base64")}`)}`;
const cookieName = "mq_protected.session_token=";

async function startAuth(url, secret, key, settings = {}) {
  const db = createAuthDatabaseClient(url);
  const observations = { rejectCreate: false, errors: 0 };
  const factory = protectedPrismaAdapter(db, key);
  let handler;
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"code":"EXPECTED_AUTH_FAILURE"}');
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(settings.port ?? 0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  function rollbackProbe(base) {
    return { ...base, async create(input) {
      const result = await base.create(input);
      if (input.model === "session" && observations.rejectCreate) {
        observations.rejectCreate = false;
        throw new Error("EXPECTED_TRANSACTION_ROLLBACK");
      }
      return result;
    }, transaction: callback => base.transaction(tx => callback(rollbackProbe(tx))) };
  }
  const options = {
    baseURL: origin, secret, trustedOrigins: [origin],
    database: options => rollbackProbe(factory(options)),
    logger: { level: "error", log: () => { observations.errors += 1; } }, onAPIError: { throw: true },
    emailAndPassword: { enabled: true, minPasswordLength: 12, password: { hash: hashPassword, verify: verifyPassword } },
    plugins: [username()],
    session: { expiresIn: settings.ttl ?? 86400, updateAge: settings.updateAge ?? 3600,
      disableSessionRefresh: !settings.refresh, cookieCache: { enabled: false } },
    advanced: { cookiePrefix: "mq_protected", useSecureCookies: false, ipAddress: { ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" } },
    rateLimit: { enabled: true, max: 1000, window: 60, customRules: {
      "/sign-up/email": { max: 1000, window: 60 }, "/sign-in/username": { max: 1000, window: 60 },
    } },
    hooks: { before: createAuthMiddleware(async ctx => {
      if (ctx.request?.method === "POST" && ctx.request.headers.get("origin") !== origin) {
        throw new APIError("FORBIDDEN", { message: "Origin required" });
      }
    }) },
  };
  const auth = betterAuth(options);
  handler = toNodeHandler(auth);
  let closed = false;
  return { db, origin, port: server.address().port, observations, adapter: factory(options),
    async request(path, { method = "GET", cookie, body, badOrigin = false } = {}) {
      const response = await fetch(`${origin}/api/auth${path}`, { method,
        headers: { origin: badOrigin ? "https://outside.invalid" : origin,
          ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
      return { status: response.status, body: await response.json(),
        cookie: response.headers.getSetCookie().find(value => value.startsWith(cookieName))?.split(";")[0] };
    },
    async close() {
      if (closed) return; closed = true;
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.$disconnect();
    },
  };
}

async function main() {
  const base = new URL(await databaseUrl("test"));
  const name = `mq_test_auth_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(base); url.pathname = `/${name}`;
  const control = new pg.Pool({ connectionString: base.href, max: 1 });
  let sql, legacy, created = false, failed = false;
  const servers = [], roles = [];
  const secret = randomBytes(32).toString("hex"), key = randomBytes(32).toString("hex");
  const password = `SyntheticOnly!${randomBytes(24).toString("base64url")}`;
  const codec = createSessionCodec(key);
  const check = async (label, action) => { stage = label; await action(); passed += 1; console.log(`PASS protected session: ${label}`); };
  const start = async (settings = {}, storageKey = key, authSecret = secret, connection = url.href) => {
    const value = await startAuth(connection, authSecret, storageKey, settings); servers.push(value); return value;
  };
  const signUp = async (server, label) => {
    const name = `p504_${label}_${randomBytes(4).toString("hex")}`;
    const value = await server.request("/sign-up/email", { method: "POST",
      body: { username: name, name, email: `${randomUUID()}@accounts.invalid`, password } });
    assert.ok(value.status === 200 && value.cookie, "Synthetic registration must create an actual cookie");
    return { ...value, username: name };
  };
  const login = async (server, user) => {
    const result = await server.request("/sign-in/username", { method: "POST", body: { username: user.username, password } });
    assert.ok(result.status === 200 && result.cookie, "Synthetic password login must succeed"); return result;
  };
  const read = (server, cookie) => server.request("/get-session", { cookie });
  const stored = async cookie => (await sql.query(`SELECT *, "createdAt" AT TIME ZONE 'UTC' AS "createdAt",
    "expiresAt" AT TIME ZONE 'UTC' AS "expiresAt", "updatedAt" AT TIME ZONE 'UTC' AS "updatedAt"
    FROM "Session" WHERE token=$1`, [codec.index(tokenOf(cookie))])).rows[0];
  const insertRow = async (pool, row) => pool.query(`INSERT INTO "Session"
    (id,"userId",token,"tokenCiphertext","createdAt","expiresAt","updatedAt","ipAddress","userAgent") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [row.id,row.userId,row.token,row.tokenCiphertext,row.createdAt.toISOString(),row.expiresAt.toISOString(),row.updatedAt.toISOString(),row.ipAddress,row.userAgent]);
  try {
    const identity = (await control.query("SELECT current_database() AS db,current_user AS actor,current_setting('server_version_num')::int AS version")).rows[0];
    assert.ok(identity.db === "mq_test" && identity.actor === "mq_test" && identity.version >= 180000 && identity.version < 190000);
    await control.query(`CREATE DATABASE "${name}"`); created = true;
    await configureTemporaryDatabaseLogging(control, name);
    sql = new pg.Pool({ connectionString: url.href, max: 3 });
    sql.on("error", () => { failed = true; });
    const legacyUser = randomUUID(), legacyToken = randomBytes(16).toString("hex"), story = randomUUID(), revision = randomUUID();
    await check("008 to current revokes only old sessions; accounts and story bytes survive", async () => {
      legacy = await prepareLegacySessionDatabase(url.href);
      await sql.query('INSERT INTO "User"(id,name,email,username,"updatedAt") VALUES($1,$2,$3,$4,now())',
        [legacyUser,"Synthetic legacy",`${randomUUID()}@accounts.invalid`,`legacy_${randomBytes(6).toString("hex")}`]);
      const oldHash = await hashPassword(password);
      await sql.query('INSERT INTO "Account"(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$2,\'credential\',$2,$3,now())', [randomUUID(),legacyUser,oldHash]);
      await sql.query('INSERT INTO "Session"(id,"userId",token,"expiresAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now())', [randomUUID(),legacyUser,legacyToken]);
      const connection = await sql.connect();
      try {
        await connection.query("BEGIN");
        await connection.query("INSERT INTO story(id,slug,kind,draft_revision_id) VALUES($1,$2,'STAR',$3)", [story,`legacy-${story}`,revision]);
        await connection.query("INSERT INTO story_revision(id,story_id,title,content) VALUES($1,$2,$3,$4::jsonb)",
          [revision,story,"Synthetic retained draft",JSON.stringify({ version:1,blocks:[{type:"paragraph",text:"Retained synthetic content"}] })]);
        await connection.query("COMMIT");
      } finally { connection.release(); }
      const before = (await sql.query("SELECT * FROM story_revision WHERE id=$1", [revision])).rows[0];
      await runPrisma(["migrate","deploy"], url.href);
      await runPrisma(["migrate","diff","--from-config-datasource","--to-schema","prisma/schema.prisma","--exit-code"],url.href);
      assert.ok((await sql.query('SELECT count(*)::int AS n FROM "Session"')).rows[0].n === 0);
      assert.ok((await sql.query('SELECT password FROM "Account" WHERE "userId"=$1',[legacyUser])).rows[0].password === oldHash);
      assert.deepEqual((await sql.query("SELECT * FROM story_revision WHERE id=$1",[revision])).rows[0],before);
      assert.equal((await sql.query('SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).rows[0].n,10);
      await legacy.cleanup(); legacy = null;
    });
    const app = await start();
    let alice, bob;
    await check("registration, username login and joined read persist no bearer", async () => {
      alice = await signUp(app,"alice"); bob = await signUp(app,"bob");
      const session = await read(app,alice.cookie), row = await stored(alice.cookie);
      assert.ok(session.status === 200 && session.body.user.id === row.userId);
      assert.ok(session.body.session.token === tokenOf(alice.cookie));
      assert.ok(!JSON.stringify(row).includes(tokenOf(alice.cookie)));
      assert.ok(!Object.hasOwn(session.body.session,"tokenCiphertext"));
      assert.ok((await read(app,signedCookie(legacyToken,secret))).body === null);
      const device = await login(app,alice); assert.ok((await read(app,device.cookie)).body);
    });
    await check("DB index and ciphertext are not accepted even with a valid test cookie signature", async () => {
      const row = await stored(alice.cookie);
      for (const value of [row.token,row.tokenCiphertext]) {
        const response = await read(app,signedCookie(value,secret));
        assert.ok(response.body === null || response.status >= 400);
      }
    });
    await check("multi-device list, single revoke and unrelated-account protection", async () => {
      const first = await login(app,alice), second = await login(app,alice);
      const list = await app.request("/list-sessions",{cookie:alice.cookie});
      assert.ok(list.status === 200 && list.body.some(item => item.token === tokenOf(first.cookie)));
      assert.ok(list.body.every(item => !Object.hasOwn(item,"tokenCiphertext") && item.userId === alice.body.user.id));
      await app.request("/revoke-session",{method:"POST",cookie:alice.cookie,body:{token:tokenOf(first.cookie)}});
      assert.ok((await read(app,first.cookie)).body === null && (await read(app,second.cookie)).body);
      await app.request("/revoke-session",{method:"POST",cookie:alice.cookie,body:{token:tokenOf(bob.cookie)}});
      assert.ok((await read(app,bob.cookie)).body);
      assert.equal((await app.request("/list-sessions")).status,401);
    });
    await check("revoke-other retains caller; revoke-all actually invalidates all its cookies", async () => {
      const other = await login(app,alice);
      await app.request("/revoke-other-sessions",{method:"POST",cookie:alice.cookie,body:{}});
      assert.ok((await read(app,other.cookie)).body === null && (await read(app,alice.cookie)).body);
      const devices = [alice.cookie,(await login(app,alice)).cookie,(await login(app,alice)).cookie];
      for (const cookie of devices) assert.ok((await read(app,cookie)).body);
      await app.request("/revoke-sessions",{method:"POST",cookie:alice.cookie,body:{}});
      for (const cookie of devices) assert.ok((await read(app,cookie)).body === null);
      assert.equal(await app.adapter.count({model:"session",where:[{field:"userId",value:alice.body.user.id}]}),0);
      assert.ok((await read(app,bob.cookie)).body);
      alice.cookie = (await login(app,alice)).cookie;
    });
    await check("current sign-out and cross-site writes", async () => {
      const device = await login(app,alice);
      assert.equal((await app.request("/sign-out",{method:"POST",cookie:device.cookie,body:{},badOrigin:true})).status,403);
      assert.ok((await read(app,device.cookie)).body);
      await app.request("/sign-out",{method:"POST",cookie:device.cookie,body:{}});
      assert.ok((await read(app,device.cookie)).body === null);
    });
    await check("real expiry and expired-row deletion", async () => {
      const short = await start({ttl:1}); const device = await login(short,alice);
      await delay(1200);
      assert.ok((await read(short,device.cookie)).body === null);
      assert.ok(!await stored(device.cookie));
      await short.close();
    });
    await check("wrong key refuses existing sessions without a raw-value fallback", async () => {
      const wrong = await start({},randomBytes(32).toString("hex"));
      assert.ok((await read(wrong,alice.cookie)).body === null); await wrong.close();
    });
    for (const field of ["id","userId","createdAt","expiresAt","token","tokenCiphertext"]) {
      await check(`SQL tampering of ${field} fails authentication`,async () => {
        const device = await login(app,alice), row = await stored(device.cookie);
        const value = field === "id" ? randomUUID() : field === "userId" ? bob.body.user.id
          : field === "createdAt" || field === "expiresAt" ? new Date(row[field].getTime()+86400000)
          : field === "token" ? `hmac1:${randomBytes(32).toString("hex")}`
          : row.tokenCiphertext.slice(0,-1)+(row.tokenCiphertext.endsWith("0")?"1":"0");
        await sql.query(`UPDATE "Session" SET "${field}"=$2 WHERE id=$1`,[row.id,value instanceof Date ? value.toISOString() : value]);
        const result = await read(app,device.cookie);
        assert.ok(result.body === null || result.status >= 400,"Tampered session must not authenticate");
        await sql.query('DELETE FROM "Session" WHERE id=$1',[field === "id" ? value : row.id]);
      });
    }
    await check("runtime-like SQL DELETE/INSERT cannot rebind a valid attacker cookie",async () => {
      const device = await login(app,alice), row = await stored(device.cookie);
      const role = `mq_sess_attack_${randomBytes(10).toString("hex")}`; roles.push(role);
      await sql.query(`CREATE ROLE "${role}" NOLOGIN`);
      await sql.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await sql.query(`GRANT SELECT,INSERT,DELETE ON "Session" TO "${role}"`);
      const conn = await sql.connect();
      try {
        await conn.query("BEGIN"); await conn.query(`SET LOCAL ROLE "${role}"`);
        await conn.query('DELETE FROM "Session" WHERE id=$1',[row.id]);
        await insertRow(conn,{...row,userId:bob.body.user.id}); await conn.query("COMMIT");
      } catch(error) { await conn.query("ROLLBACK"); throw error; } finally { conn.release(); }
      const result = await read(app,device.cookie); assert.ok(result.body === null || result.status >= 400);
      await sql.query('DELETE FROM "Session" WHERE id=$1',[row.id]);
    });
    await check("whole valid-row replay remains a documented DB-integrity trust boundary",async () => {
      const device = await login(app,alice), row = await stored(device.cookie);
      await app.request("/sign-out",{method:"POST",cookie:device.cookie,body:{}});
      assert.ok((await read(app,device.cookie)).body === null);
      await insertRow(sql,row);
      assert.ok((await read(app,device.cookie)).body?.user.id === alice.body.user.id,
        "AEAD cannot prove a previously valid whole row was not replayed by a SQL writer");
      await sql.query('DELETE FROM "Session" WHERE id=$1',[row.id]);
    });
    await check("signed fields cannot be laundered through the framework update path",async () => {
      const device = await login(app,alice), row = await stored(device.cookie);
      await sql.query('UPDATE "Session" SET "userId"=$2 WHERE id=$1',[row.id,bob.body.user.id]);
      await assert.rejects(app.adapter.update({model:"session",where:[{field:"id",value:row.id}],update:{expiresAt:new Date(Date.now()+86400000)}}));
      await sql.query('DELETE FROM "Session" WHERE id=$1',[row.id]);
    });
    await check("partial selects, token-in queries and reverse user-session joins preserve semantics",async () => {
      const device = await login(app,alice);
      const selected = await app.adapter.findOne({model:"session",where:[{field:"token",value:tokenOf(device.cookie)}],select:["token"]});
      assert.ok(selected.token === tokenOf(device.cookie) && Object.keys(selected).length === 1);
      const many = await app.adapter.findMany({model:"session",where:[{field:"token",operator:"in",value:[tokenOf(device.cookie),tokenOf(bob.cookie)]}]});
      assert.equal(many.length,2); assert.ok(many.every(row => !row.tokenCiphertext && /^[a-zA-Z0-9]{32}$/.test(row.token)));
      assert.ok([tokenOf(device.cookie),tokenOf(bob.cookie)].every(token => many.some(row => row.token === token)));
      const joined = await app.adapter.findOne({model:"user",where:[{field:"id",value:alice.body.user.id}],join:{session:true}});
      const rows = joined.session ?? joined.sessions;
      assert.ok(Array.isArray(rows) && rows.some(row => row.token === tokenOf(device.cookie)));
      assert.ok(rows.every(row => !row.tokenCiphertext));
    });
    await check("registration failure after actual protected INSERT rolls back User Account and Session",async () => {
      const before = await app.db.user.count(); app.observations.rejectCreate = true;
      const username = `rollback_${randomBytes(8).toString("hex")}`;
      const result = await app.request("/sign-up/email",{method:"POST",body:{username,name:username,email:`${randomUUID()}@accounts.invalid`,password}});
      assert.ok(result.status >= 400 && await app.db.user.count() === before);
      assert.equal(await app.db.user.count({where:{username}}),0);
    });
    await check("transaction replacement failure restores the original session",async () => {
      const device = await login(app,alice), before = await stored(device.cookie);
      await assert.rejects(app.adapter.transaction(async tx => {
        await tx.update({model:"session",where:[{field:"token",value:tokenOf(device.cookie)}],update:{expiresAt:new Date(Date.now()+7200000)}});
        throw new Error("EXPECTED_ROLLBACK");
      }));
      const after = await stored(device.cookie);
      assert.ok(after.tokenCiphertext === before.tokenCiphertext && (await read(app,device.cookie)).body);
    });
    await check("updateMany covers more than one page; consume and deleteMany retain exact semantics",async () => {
      const user = await signUp(app,"batch"), now = new Date();
      await app.adapter.transaction(async tx => {
        for(let i=0;i<105;i++) await tx.create({model:"session",data:{userId:user.body.user.id,
          token:randomBytes(16).toString("hex"),createdAt:now,updatedAt:now,expiresAt:new Date(Date.now()+3600000),ipAddress:null,userAgent:null}});
      });
      const where=[{field:"userId",value:user.body.user.id}];
      assert.equal(await app.adapter.count({model:"session",where}),106);
      const nextExpiry=new Date(Date.now()+7200000);
      assert.equal(await app.adapter.updateMany({model:"session",where,update:{expiresAt:nextExpiry}}),106);
      const updated=await app.adapter.findMany({model:"session",where,limit:200});
      assert.equal(updated.length,106);
      assert.ok(updated.every(row => row.expiresAt.getTime() === nextExpiry.getTime() && /^[A-Za-z0-9]{32}$/.test(row.token)));
      const taken=await app.adapter.consumeOne({model:"session",where:[{field:"token",value:tokenOf(user.cookie)}]});
      assert.ok(taken.token===tokenOf(user.cookie) && !taken.tokenCiphertext && (await read(app,user.cookie)).body===null);
      assert.equal(await app.adapter.deleteMany({model:"session",where}),105);
      assert.equal(await app.adapter.count({model:"session",where}),0);
    });
    await check("parallel logins create distinct sessions; repeated targeted revocation is idempotent",async () => {
      const devices = await Promise.all([login(app,alice),login(app,alice)]);
      assert.equal(new Set(devices.map(device=>tokenOf(device.cookie))).size,2);
      await Promise.all(devices.flatMap(device=>[1,2].map(()=>app.request("/revoke-session",{
        method:"POST",cookie:alice.cookie,body:{token:tokenOf(device.cookie)}}))));
      for (const device of devices) assert.ok((await read(app,device.cookie)).body === null);
    });
    await check("refresh uses SELECT INSERT DELETE only, and concurrent revoke never resurrects a session",async () => {
      const role = `mq_sess_runtime_${randomBytes(10).toString("hex")}`; roles.push(role);
      const rolePassword = randomBytes(32).toString("hex");
      await sql.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      await sql.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
      await sql.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await sql.query(`GRANT SELECT,INSERT ON "User","Account" TO "${role}"`);
      await sql.query(`GRANT SELECT,INSERT,DELETE ON "Session" TO "${role}"`);
      const lowUrl = new URL(url); lowUrl.username=role; lowUrl.password=rolePassword;
      const refreshing = await start({ttl:10,updateAge:1,refresh:true},key,secret,lowUrl.href);
      const device = await login(refreshing,alice), before = await stored(device.cookie);
      await delay(1150); const refreshed = await read(refreshing,device.cookie);
      assert.ok(refreshed.status === 200 && refreshed.body?.session.token === tokenOf(device.cookie));
      const after = await stored(device.cookie); assert.ok(after.expiresAt > before.expiresAt && after.tokenCiphertext !== before.tokenCiphertext);
      assert.ok(!(await sql.query("SELECT has_any_column_privilege($1,'public.\"Session\"','UPDATE') AS allowed",[role])).rows[0].allowed);
      await delay(1100);
      await Promise.all([read(refreshing,device.cookie),app.request("/revoke-session",{method:"POST",cookie:alice.cookie,body:{token:tokenOf(device.cookie)}})]);
      assert.ok((await read(refreshing,device.cookie)).body === null);
      await refreshing.close();
    });
    await check("separate HTTP instances and listener restart retain cookies with the same independent key",async () => {
      const second = await start(); const device = await login(app,alice);
      assert.ok((await read(second,device.cookie)).body?.user.id === alice.body.user.id);
      const port=second.port; await second.close(); const restarted=await start({port});
      assert.ok((await read(restarted,device.cookie)).body?.user.id === alice.body.user.id); await restarted.close();
    });
    await check("native maintenance DELETE blocked during replacement removes the committed new row",async () => {
      const device=await login(app,alice);
      let release, signal;
      const hold=new Promise(resolve=>{release=resolve;});
      const ready=new Promise(resolve=>{signal=resolve;});
      const replacement=app.adapter.transaction(async tx=>{
        await tx.update({model:"session",where:[{field:"token",value:tokenOf(device.cookie)}],update:{expiresAt:new Date(Date.now()+7200000)}});
        signal(); await hold;
      });
      const connection=await sql.connect(); let deletion;
      try {
        await Promise.race([ready,replacement]);
        const pid=(await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        deletion=connection.query('DELETE FROM "Session" WHERE token=$1',[codec.index(tokenOf(device.cookie))]);
        const deadline=Date.now()+2000;
        while((await control.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.wait_event_type!=="Lock") {
          assert.ok(Date.now()<deadline,"Maintenance delete must actually wait on the replacement lock"); await delay(10);
        }
      } finally { release(); try { await replacement; if(deletion) await deletion; } finally { connection.release(); } }
      assert.ok((await read(app,device.cookie)).body===null);
    });
    await check("storage-key and cookie-secret rotations revoke old sessions; rollback cannot revive them",async () => {
      const oldCookie=alice.cookie, nextKey=randomBytes(32).toString("hex"), nextSecret=randomBytes(32).toString("hex");
      // Test-only maintenance action in the newly created random database.
      await sql.query('DELETE FROM "Session"');
      const rotated=await start({},nextKey,nextSecret); const next=await login(rotated,alice);
      assert.ok((await read(rotated,next.cookie)).body && (await read(rotated,oldCookie)).body===null);
      assert.ok((await read(app,oldCookie)).body===null && (await read(app,next.cookie)).body===null);
      const newRow=(await sql.query('SELECT * FROM "Session" WHERE "userId"=$1',[alice.body.user.id])).rows[0];
      assert.ok(!JSON.stringify(newRow).includes(tokenOf(next.cookie))); await rotated.close();
    });
    await check("existing administrator revocation trigger cannot miss an in-flight replacement",async () => {
      const admin=await signUp(app,"adminrace");
      await sql.query('INSERT INTO "AdminGrant" (id,"userId") VALUES(1,$1)',[admin.body.user.id]);
      const device=await login(app,admin);
      let release, signal;
      const hold=new Promise(resolve=>{release=resolve;});
      const ready=new Promise(resolve=>{signal=resolve;});
      const replacement=app.adapter.transaction(async tx=>{
        await tx.update({model:"session",where:[{field:"token",value:tokenOf(device.cookie)}],update:{expiresAt:new Date(Date.now()+7200000)}});
        signal(); await hold;
      });
      const connection=await sql.connect(); let revocation;
      try {
        await Promise.race([ready,replacement]);
        const pid=(await connection.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        revocation=connection.query('UPDATE "AdminGrant" SET "revokedAt"=clock_timestamp(),version=version+1 WHERE id=1');
        const deadline=Date.now()+2000;
        while((await control.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.wait_event_type!=="Lock") {
          assert.ok(Date.now()<deadline,"Existing grant trigger must actually wait"); await delay(10);
        }
      } finally { release(); try { await replacement; if(revocation) await revocation; } finally { connection.release(); } }
      assert.ok((await read(app,device.cookie)).body===null);
      assert.equal((await sql.query('SELECT count(*)::int AS n FROM "Session" WHERE "userId"=$1',[admin.body.user.id])).rows[0].n,0);
    });
    assert.ok(!failed,"No unhandled database pool errors");
    console.log(`Protected Session PostgreSQL/HTTP: ${passed}/${passed} checks passed; no raw secrets emitted`);
  } finally {
    await Promise.all(servers.map(server=>server.close()));
    if(legacy) await legacy.cleanup();
    if(sql) {
      for(const role of roles) { await sql.query(`DROP OWNED BY "${role}"`); }
      await sql.end();
    }
    if(created) {
      const deadline=Date.now()+10000;
      while((await control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1",[name])).rows[0].n) {
        assert.ok(Date.now()<deadline,"Test connections must drain before cleanup"); await delay(50);
      }
      await control.query(`DROP DATABASE "${name}"`);
    }
    for(const role of roles) await control.query(`DROP ROLE "${role}"`);
    await control.end();
  }
}
main().catch(error=>{
  const frame = error?.stack?.split("\n").find(line=>line.includes("session-storage-integration.mjs:"))?.trim();
  console.error(`Protected Session integration failed at: ${stage}; category=${error?.name}; code=${error?.code ?? "none"}; ${frame ?? "no local frame"}; values withheld`);
  process.exitCode=1;
});
