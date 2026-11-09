import { sessionFixture } from "../auth/session-fixture.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import pg from "pg";
import sharp from "sharp";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin, revokeAdmin, restoreAdmin } from "../../src/server/admin/maintenance.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INPUT = 3 * 1024 * 1024;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Real raw HTTP transport, including streaming requests that pause after the
// authenticated PENDING reservation. No HAR, body, cookie or response dump.
export function transport(origin, secrets, ca) {
  const endpoint = new URL(origin);
  assert.equal(endpoint.hostname, "127.0.0.1");
  assert.ok(endpoint.protocol === "http:" || (endpoint.protocol === "https:" && ca));
  const network = endpoint.protocol === "https:" ? https : http;
  function open(path, { method = "GET", body, bytes, mime, id, jar, requestOrigin = origin, headers = {}, held = false, chunked = false } = {}) {
    const sent = { ...headers };
    if (requestOrigin !== null) sent.origin = requestOrigin;
    if (jar?.cookie) sent.cookie = jar.cookie;
    if (id) sent["idempotency-key"] = id;
    let input = bytes;
    if (body !== undefined) { input = Buffer.from(JSON.stringify(body)); sent["content-type"] = "application/json"; }
    else if (mime) sent["content-type"] = mime;
    if (input && !chunked && !Object.hasOwn(sent, "content-length")) sent["content-length"] = String(input.length);
    let outgoing;
    const result = new Promise((resolve, reject) => {
      outgoing = network.request(new URL(path, origin), { method, ca, headers: sent, timeout: 35_000 }, incoming => {
        const chunks = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.once("error", reject);
        incoming.once("end", () => {
          try {
            const buffer = Buffer.concat(chunks), text = buffer.toString("utf8");
            assert.ok(!text.includes("@accounts.invalid"), "Internal email must stay private");
            assert.ok(!/"(?:storageKey|storage_key|path|password|email|emailVerified|token|tokenCiphertext)"\s*:/.test(text), "Internal fields must stay private");
            assert.ok([...secrets].every(value => !value || !buffer.includes(Buffer.from(value))), "Synthetic secret must stay out of responses");
            const cookieLines = incoming.headers["set-cookie"] ?? [];
            for (const line of cookieLines) {
              if (!/^(?:__Secure-)?mq\.session_token=/.test(line) || /max-age=0(?:;|$)/i.test(line)) continue;
              const cookie = line.split(";", 1)[0];
              secrets.add(cookie); secrets.add(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".", 1)[0]);
            }
            if (jar) for (const line of cookieLines) {
              if (/^(?:__Secure-)?mq\.session_token=/.test(line)) jar.cookie = /max-age=0(?:;|$)/i.test(line) ? "" : line.split(";", 1)[0];
            }
            let data = null;
            if (/application\/json/.test(incoming.headers["content-type"] ?? "") && text) data = JSON.parse(text);
            resolve({ status: incoming.statusCode, headers: incoming.headers, data, bytes: buffer, text, cookieLines });
          } catch (error) { reject(error); }
        });
      });
      outgoing.once("error", reject);
      outgoing.once("timeout", () => outgoing.destroy(new Error("MEDIA_TEST_REQUEST_TIMEOUT")));
      if (held || chunked) {
        outgoing.write(input.subarray(0, 1));
        if (!held) outgoing.end(input.subarray(1));
      } else outgoing.end(input);
    });
    // Attach rejection handling immediately while callers inspect PostgreSQL.
    result.catch(() => {});
    return { result, finish() { outgoing.end(input.subarray(1)); }, abort() { outgoing.destroy(); } };
  }
  return { request: (path, options) => open(path, options).result, held: (path, options) => open(path, { ...options, held: true }) };
}

export function privateHeaders(response) {
  assert.match(response.headers["cache-control"] ?? "", /(?:^|,\s*)no-store(?:,|$)/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers["last-modified"], undefined);
  assert.notEqual(response.status, 304);
}

export function assetDto(asset) {
  assert.deepEqual(Object.keys(asset).sort(), ["id", "state", "createdAt", "display", "thumbnail", "publishedStoryCount"].sort());
  assert.ok(Number.isInteger(asset.publishedStoryCount) && asset.publishedStoryCount >= 0);
  assert.match(asset.id, UUID);
  assert.ok(Number.isFinite(Date.parse(asset.createdAt)));
  assert.ok(["PENDING", "READY", "FAILED", "DELETING", "DELETED"].includes(asset.state));
  for (const name of ["display", "thumbnail"]) {
    if (asset[name] === null) continue;
    assert.deepEqual(Object.keys(asset[name]).sort(), ["mimeType", "width", "height", "byteLength", "sha256"].sort());
    assert.equal(asset[name].mimeType, "image/webp");
    assert.match(asset[name].sha256, /^[a-f0-9]{64}$/);
  }
}

export async function runMediaUploadHttpTests({ connectionString, maintenanceUrl, runtimeRole, origin, storageRoot, restartServer }) {
  const target = new URL(connectionString);
  assert.match(target.pathname, /^\/mq_test_admin_[a-f0-9]{32}$/);
  assert.equal(target.username, "mq_test");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  assert.match(runtimeRole, /^mq_admin_rt_[a-f0-9]{32}$/);
  const owner = new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000 });
  const maintenance = createAuthDatabaseClient(maintenanceUrl);
  const suffix = randomBytes(5).toString("hex"), username = `media_${suffix}`, ordinaryUsername = `reader_${suffix}`;
  const password = `MqMedia!${randomBytes(24).toString("base64url")}`, ordinaryPassword = `MqReader!${randomBytes(24).toString("base64url")}`;
  const secrets = new Set([password, ordinaryPassword, storageRoot]);
  const { request, held } = transport(origin, secrets);
  let jar = {}, ordinaryJar = {}, grant, stage = "initialize", passed = 0;
  const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#456789" } }).png().toBuffer();
  const snapshot = async () => (await owner.query(`SELECT (SELECT count(*) FROM story)::int AS stories,
    (SELECT count(*) FROM story_revision)::int AS revisions,(SELECT count(*) FROM story_revision_asset)::int AS refs,
    (SELECT count(*) FROM star_slot)::int AS slots`)).rows[0];
  const beforeStories = await snapshot();
  const assetPath = id => `/api/admin/media/${id}`;
  const contentPath = id => `${assetPath(id)}/content`;
  async function collectSecrets() {
    const values = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT "tokenCiphertext" AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL UNION ALL SELECT storage_key::text AS value FROM media_asset')).rows;
    values.forEach(row => secrets.add(row.value));
  }
  async function run(name, action) {
    stage = name;
    await owner.query('DELETE FROM "AuthRateLimit"'); await owner.query('DELETE FROM "RateLimit"');
    await action(); await collectSecrets(); passed += 1; console.log(`PASS media HTTP: ${name}`);
  }
  async function login() {
    const next = {};
    const result = await request("/api/auth/sign-in/username", { method: "POST", body: { username, password }, jar: next });
    assert.equal(result.status, 200); assert.ok(next.cookie); await collectSecrets(); return next;
  }
  async function upload(bytes = png, mime = "image/png", id = randomUUID(), options = {}) {
    return { id, response: await request("/api/admin/media", { method: "POST", bytes, mime, id, jar, ...options }) };
  }
  async function pending(id) {
    for (let n = 0; n < 100; n++) {
      const row = (await owner.query("SELECT state,storage_key,created_at FROM media_asset WHERE id=$1", [id])).rows[0];
      if (row) { assert.equal(row.state, "PENDING"); secrets.add(row.storage_key); return row; }
      await delay(25);
    }
    throw new Error("MEDIA_PENDING_NOT_OBSERVED");
  }
  async function verifyOutput(id, dto, expectedWidth, expectedHeight) {
    assetDto(dto); assert.equal(dto.state, "READY");
    const stored = (await owner.query("SELECT * FROM media_asset WHERE id=$1", [id])).rows[0]; secrets.add(stored.storage_key);
    for (const variant of ["display", "thumbnail"]) {
      const response = await request(`${contentPath(id)}?variant=${variant}`, { jar });
      assert.equal(response.status, 200); privateHeaders(response);
      assert.match(response.headers["content-type"], /^image\/webp/);
      const decoded = await sharp(response.bytes).metadata(), info = dto[variant];
      assert.equal(decoded.format, "webp"); assert.equal(decoded.width, info.width); assert.equal(decoded.height, info.height);
      assert.equal(response.bytes.length, info.byteLength); assert.equal(hash(response.bytes), info.sha256);
      assert.equal(stored[`${variant}_bytes`], response.bytes.length); assert.equal(stored[`${variant}_sha256`], hash(response.bytes));
      assert.equal(stored[`${variant}_width`], decoded.width); assert.equal(stored[`${variant}_height`], decoded.height);
      for (const field of ["exif", "xmp", "icc", "iptc", "orientation"]) assert.equal(decoded[field], undefined);
      assert.deepEqual(await readFile(join(storageRoot, stored.storage_key, `${variant}.webp`)), response.bytes);
    }
    assert.equal(dto.display.width, expectedWidth); assert.equal(dto.display.height, expectedHeight);
    assert.ok(Math.max(dto.thumbnail.width, dto.thumbnail.height) <= 400);
    assert.deepEqual((await readdir(join(storageRoot, stored.storage_key))).sort(), ["display.webp", "thumbnail.webp"]);
  }
  let readyId, readyDto;
  const interrupted = [];
  try {
    await run("guest and ordinary sessions cannot upload, list, inspect or read private media", async () => {
      const id = randomUUID();
      for (const options of [{ method: "POST", bytes: png, mime: "image/png", id }, {}]) {
        assert.equal((await request("/api/admin/media", options)).status, 401);
      }
      for (const path of [assetPath(id), contentPath(id)]) {
        assert.equal((await request(path)).status, 401);
        assert.equal((await request(path, { method: "HEAD" })).status, 401);
      }
      assert.equal((await request("/api/auth/sign-up/email", { method: "POST", body: { username: ordinaryUsername, password: ordinaryPassword }, jar: ordinaryJar })).status, 200);
      for (const path of ["/api/admin/media", assetPath(id), contentPath(id)]) assert.equal((await request(path, { jar: ordinaryJar })).status, 403);
      assert.equal((await request("/api/admin/media", { method: "POST", bytes: png, mime: "image/png", id, jar: ordinaryJar, headers: { "x-role": "admin" } })).status, 403);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM media_asset")).rows[0].n, 0);
    });
    await run("three supported real formats produce server-verified private variants", async () => {
      grant = await initializeAdmin(maintenance, { username, password }); jar = await login();
      for (const format of ["jpeg", "png", "webp"]) {
        const bytes = await sharp(png).toFormat(format).toBuffer();
        const result = await upload(bytes, `image/${format}`);
        assert.equal(result.response.status, 201); privateHeaders(result.response);
        await verifyOutput(result.id, result.response.data.asset, 1920, 960);
        readyId = result.id; readyDto = result.response.data.asset;
      }
    });
    await run("EXIF orientation is applied and GPS, EXIF and XMP are removed in real HTTP outputs", async () => {
      const source = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#7090a0" } }).jpeg()
        .withMetadata({ orientation: 6 }).withExifMerge({ IFD0: { Artist: "SYNTHETIC_MEDIA_ONLY" }, IFD3: {
          GPSLatitudeRef: "N", GPSLatitude: "1/1 2/1 3/1", GPSLongitudeRef: "E", GPSLongitude: "4/1 5/1 6/1",
        } }).withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">SYNTHETIC_MEDIA_PRIVATE</x:xmpmeta>').toBuffer();
      const original = await sharp(source).metadata(); assert.equal(original.orientation, 6); assert.ok(original.exif && original.xmp);
      const result = await upload(source, "image/jpeg"); assert.equal(result.response.status, 201);
      await verifyOutput(result.id, result.response.data.asset, 80, 120);
    });
    await run("request and content validation reject spoofed types, URLs, corrupt, huge and animated inputs", async () => {
      const frames = await Promise.all(["red", "blue"].map(background => sharp({ create: { width: 16, height: 16, channels: 3, background } }).png().toBuffer()));
      const animation = await sharp(frames, { join: { animated: true } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
      assert.equal((await sharp(animation, { animated: true }).metadata()).pages, 2);
      const overPixels = await sharp({ create: { width: 6001, height: 4000, channels: 3, background: "black" } }).png().toBuffer();
      const rejected = [
        [png, "image/jpeg", 415], [png, "image/svg+xml", 415],
        [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/png", 415],
        [await sharp(png).gif().toBuffer(), "image/png", 415],
        [Buffer.from("\0\0\0\x18ftypheicSYNTHETIC"), "image/png", 415],
        [Buffer.from("https://example.invalid/private.png"), "image/png", 415],
        [Buffer.from([0xff, 0xd8, 0xff, 0]), "image/jpeg", 422],
        [animation, "image/webp", 415], [overPixels, "image/png", 413], [Buffer.alloc(MAX_INPUT + 1), "image/png", 413],
      ];
      for (const [bytes, mime, status] of rejected) {
        const result = await upload(bytes, mime); assert.equal(result.response.status, status); privateHeaders(result.response);
        const row = (await owner.query("SELECT state FROM media_asset WHERE id=$1", [result.id])).rows[0];
        assert.ok(!row || row.state === "FAILED");
      }
      const streamed = await upload(Buffer.alloc(MAX_INPUT + 1), "image/png", randomUUID(), { chunked: true });
      assert.equal(streamed.response.status, 413);
      assert.equal((await request("/api/admin/media", { method: "POST", bytes: png, mime: "image/png", jar })).status, 400);
      assert.equal((await upload(png, "image/png", "../escape")).response.status, 400);
    });
    await run("reused upload identifiers never create or overwrite a second asset", async () => {
      const before = (await owner.query("SELECT count(*)::int AS n FROM media_asset")).rows[0].n;
      const duplicate = await upload(png, "image/png", readyId); assert.equal(duplicate.response.status, 409);
      const state = await request(assetPath(readyId), { jar }); assert.equal(state.status, 200); assetDto(state.data.asset);
      assert.deepEqual(state.data.asset, readyDto);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM media_asset")).rows[0].n, before);
      assert.equal(hash((await request(contentPath(readyId), { jar })).bytes), readyDto.display.sha256);
    });
    await run("a discarded successful response is resolved by authenticated status instead of a duplicate upload", async () => {
      const id = randomUUID();
      await new Promise((done, reject) => {
        // Deliberately lose the response body at the client after the HTTP
        // server has produced headers. No retry is hidden in this transport.
        let discarded = false;
        const outgoing = http.request(new URL("/api/admin/media", origin), { method: "POST", headers: {
          origin, cookie: jar.cookie, "idempotency-key": id, "content-type": "image/png", "content-length": String(png.length),
        }, timeout: 30_000 }, incoming => { discarded = true; incoming.destroy(); outgoing.destroy(); done(); });
        outgoing.once("error", error => { if (!discarded) reject(error); });
        outgoing.once("timeout", () => outgoing.destroy(new Error("MEDIA_TEST_REQUEST_TIMEOUT")));
        outgoing.end(png);
      });
      const state = await request(assetPath(id), { jar }); assert.equal(state.status, 200); assert.equal(state.data.asset.state, "READY");
      assetDto(state.data.asset);
      assert.equal((await upload(png, "image/png", id)).response.status, 409);
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM media_asset WHERE id=$1", [id])).rows[0].n, 1);
    });
    await run("private list uses bounded pagination and only safe metadata", async () => {
      const first = await request("/api/admin/media?limit=2", { jar }); assert.equal(first.status, 200); privateHeaders(first);
      assert.equal(first.data.items.length, 2); first.data.items.forEach(assetDto); assert.match(first.data.nextCursor, UUID);
      const second = await request(`/api/admin/media?limit=2&cursor=${first.data.nextCursor}`, { jar }); assert.equal(second.status, 200);
      assert.ok(second.data.items.every(item => !first.data.items.some(previous => previous.id === item.id)));
      for (const query of ["limit=0", "limit=51", "limit=x", "cursor=../private", "extra=1"]) assert.equal((await request(`/api/admin/media?${query}`, { jar })).status, 400);
    });
    await run("HEAD, conditionals, forged Origin, optimizer and traversal cannot bypass private access", async () => {
      const conditional = { "if-none-match": "*", "if-modified-since": "Wed, 01 Jan 2099 00:00:00 GMT" };
      const head = await request(contentPath(readyId), { method: "HEAD", jar, headers: conditional });
      assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); privateHeaders(head);
      assert.equal(Number(head.headers["content-length"]), readyDto.display.byteLength);
      const conditionalGet = await request(contentPath(readyId), { jar, headers: conditional }); assert.equal(conditionalGet.status, 200); privateHeaders(conditionalGet);
      for (const method of ["GET", "HEAD"]) {
        const guest = await request(contentPath(readyId), { method, headers: conditional }); assert.equal(guest.status, 401); privateHeaders(guest);
        assert.equal((await request(contentPath(readyId), { method, jar: ordinaryJar, headers: conditional })).status, 403);
      }
      assert.equal((await upload(png, "image/png", randomUUID(), { requestOrigin: "https://attacker.invalid" })).response.status, 403);
      assert.equal((await upload(png, "image/png", randomUUID(), { requestOrigin: null })).response.status, 403);
      assert.equal((await request(contentPath(readyId), { jar, headers: { "sec-fetch-site": "cross-site" } })).status, 403);
      for (const path of [contentPath(readyId), `${contentPath(readyId)}?variant=thumbnail`]) {
        const optimized = `/_next/image?url=${encodeURIComponent(path)}&w=640&q=75`;
        for (const actor of [undefined, jar]) assert.equal((await request(optimized, { jar: actor })).status, 400);
      }
      for (const query of ["variant=original", "variant=../display", "path=../../private"]) assert.equal((await request(`${contentPath(readyId)}?${query}`, { jar })).status, 400);
      assert.equal((await request("/api/admin/media/not-a-uuid/content", { jar })).status, 400);
      const key = (await owner.query("SELECT storage_key FROM media_asset WHERE id=$1", [readyId])).rows[0].storage_key;
      assert.equal((await request(`/media/${key}/display.webp`)).status, 404);
    });
    await run("database authorization failure fails closed and recovers without losing confirmed bytes", async () => {
      await owner.query(`REVOKE SELECT ON media_asset FROM "${runtimeRole}"`);
      try {
        for (const path of ["/api/admin/media", assetPath(readyId), contentPath(readyId)]) assert.equal((await request(path, { jar })).status, 503);
      } finally { await owner.query(`GRANT SELECT ON media_asset TO "${runtimeRole}"`); }
      assert.equal(hash((await request(contentPath(readyId), { jar })).bytes), readyDto.display.sha256);
    });
    await run("finalization transaction failure rolls back READY and removes only failed generated outputs", async () => {
      await owner.query("CREATE FUNCTION mq_test_media_finalize_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='READY' THEN RAISE EXCEPTION 'Synthetic media finalization failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$");
      await owner.query("CREATE TRIGGER mq_test_media_finalize_failure BEFORE UPDATE ON media_asset FOR EACH ROW EXECUTE FUNCTION mq_test_media_finalize_failure()");
      let result;
      try { result = await upload(); assert.equal(result.response.status, 503); }
      finally { await owner.query("DROP TRIGGER mq_test_media_finalize_failure ON media_asset"); await owner.query("DROP FUNCTION mq_test_media_finalize_failure()"); }
      const state = await request(assetPath(result.id), { jar }); assert.equal(state.status, 200); assert.equal(state.data.asset.state, "FAILED");
      assert.equal((await request(contentPath(result.id), { jar })).status, 404);
      const row = (await owner.query("SELECT storage_key,display_sha256 FROM media_asset WHERE id=$1", [result.id])).rows[0];
      assert.equal(row.display_sha256, null); assert.ok(!(await readdir(storageRoot)).includes(row.storage_key));
    });
    await run("actual private-file write failure preserves FAILED state and permits controlled recovery", async () => {
      const id = randomUUID(), attempt = held("/api/admin/media", { method: "POST", bytes: png, mime: "image/png", id, jar });
      const row = await pending(id), directory = join(storageRoot, row.storage_key);
      await mkdir(directory, { mode: 0o700 }); await mkdir(join(directory, "display.webp"), { mode: 0o700 });
      attempt.finish(); assert.equal((await attempt.result).status, 503);
      assert.equal((await owner.query("SELECT state FROM media_asset WHERE id=$1", [id])).rows[0].state, "FAILED");
      await rmdir(join(directory, "display.webp"));
      const state = await request(assetPath(id), { jar }); assert.equal(state.status, 200); assert.equal(state.data.asset.state, "FAILED");
      assert.ok(!(await readdir(storageRoot)).includes(row.storage_key));
    });
    await run("an unfinished real request body times out and cannot remain uploadable", async () => {
      const id = randomUUID(), attempt = held("/api/admin/media", { method: "POST", bytes: png, mime: "image/png", id, jar });
      const row = await pending(id);
      try {
        const response = await attempt.result; assert.equal(response.status, 408); privateHeaders(response);
        const state = await request(assetPath(id), { jar }); assert.equal(state.status, 200); assert.equal(state.data.asset.state, "FAILED");
        assert.equal((await request(contentPath(id), { jar })).status, 404);
        assert.ok(!(await readdir(storageRoot)).includes(row.storage_key));
      } finally { attempt.abort(); }
    });
    await run("shared PENDING quota gives exactly one winner to concurrent claims for the final place", async () => {
      const attempts = [], candidates = [];
      try {
        for (let n = 0; n < 3; n++) {
          const id = randomUUID(), attempt = held("/api/admin/media", { method: "POST", bytes: png, mime: "image/png", id, jar });
          attempts.push(attempt); await pending(id);
        }
        for (let n = 0; n < 3; n++) {
          const id = randomUUID(), attempt = held("/api/admin/media", { method: "POST", bytes: png, mime: "image/png", id, jar });
          const entry = { id, attempt, response: null }; candidates.push(entry);
          attempt.result.then(response => { entry.response = response; }, () => {});
        }
        let observed = false;
        for (let n = 0; n < 150; n++) {
          const rows = (await owner.query("SELECT id,state FROM media_asset WHERE id=ANY($1::uuid[])", [candidates.map(entry => entry.id)])).rows;
          if (rows.length === 1 && rows[0].state === "PENDING" && candidates.filter(entry => entry.response?.status === 429).length === 2) {
            observed = true; break;
          }
          await delay(20);
        }
        assert.ok(observed, "Three genuinely overlapping HTTP reservations must have one PENDING winner and two quota rejections");
        assert.equal((await owner.query("SELECT count(*)::int AS n FROM media_asset WHERE state='PENDING'")).rows[0].n, 4);
      } finally {
        [...attempts, ...candidates.map(entry => entry.attempt)].forEach(attempt => attempt.finish());
        const responses = await Promise.all([...attempts, ...candidates.map(entry => entry.attempt)].map(attempt => attempt.result));
        assert.equal(responses.filter(response => response.status === 201).length, 4);
        assert.equal(responses.filter(response => response.status === 429).length, 2);
      }
    });
    await run("revocation during the body stream prevents READY, including copied old sessions", async () => {
      const id = randomUUID(), attempt = held("/api/admin/media", { method: "POST", bytes: png, mime: "image/png", id, jar });
      const row = await pending(id); interrupted.push({ id, ...row });
      const copied = { ...jar }; grant = await revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      attempt.finish(); assert.ok([401, 403].includes((await attempt.result).status));
      assert.notEqual((await owner.query("SELECT state FROM media_asset WHERE id=$1", [id])).rows[0].state, "READY");
      assert.equal((await request(contentPath(readyId), { jar: copied })).status, 401);
      jar = await login(); assert.equal((await request(contentPath(readyId), { jar })).status, 403);
      assert.equal((await upload()).response.status, 403);
      grant = await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version }); jar = await login();
    });
    await run("expired, logged-out and forged cookies cannot upload or read confirmed assets", async () => {
      const forged = { cookie: jar.cookie.slice(0, -1) + (jar.cookie.endsWith("a") ? "b" : "a") };
      assert.equal((await request(contentPath(readyId), { jar: forged })).status, 401);
      await sessionFixture.expire(owner, grant.userId);
      assert.equal((await upload()).response.status, 401); assert.equal((await request(contentPath(readyId), { jar })).status, 401);
      jar = await login(); const copied = { ...jar };
      assert.equal((await request("/api/auth/sign-out", { method: "POST", body: {}, jar })).status, 200);
      assert.equal((await request(contentPath(readyId), { jar: copied })).status, 401); jar = await login();
    });
    await run("real server interruption leaves PENDING private and status recovery expires it without reupload", async () => {
      const id = randomUUID(), attempt = held("/api/admin/media", { method: "POST", bytes: png, mime: "image/png", id, jar });
      const row = await pending(id); interrupted.push({ id, ...row });
      await restartServer(); attempt.abort(); await attempt.result.catch(() => {});
      const immediate = await request(assetPath(id), { jar }); assert.equal(immediate.status, 200); assert.equal(immediate.data.asset.state, "PENDING");
      assert.equal((await upload(png, "image/png", id)).response.status, 409);
      console.log("WAIT media recovery: observing the real 120-second PENDING deadline after killing the test-owned server");
      const deadline = Math.max(...interrupted.map(item => new Date(item.created_at).getTime())) + 121_000;
      while (Date.now() < deadline) await delay(Math.min(1000, deadline - Date.now()));
      for (const entry of interrupted) {
        const recovered = await request(assetPath(entry.id), { jar }); assert.equal(recovered.status, 200); assert.equal(recovered.data.asset.state, "FAILED");
        assert.equal((await request(contentPath(entry.id), { jar })).status, 404);
        assert.ok(!(await readdir(storageRoot)).includes(entry.storage_key));
      }
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM media_asset WHERE id=$1", [id])).rows[0].n, 1);
    });
    await run("uploads never publish images, mutate stories or leave original/temp files", async () => {
      assert.deepEqual(await snapshot(), beforeStories);
      const catalog = await request("/api/stories"); assert.equal(catalog.status, 200); assert.ok(!catalog.text.includes(readyId));
      const media = (await owner.query("SELECT id,state,storage_key FROM media_asset")).rows;
      assert.ok(media.length < 30);
      for (const row of media) {
        if (row.state === "READY") assert.deepEqual((await readdir(join(storageRoot, row.storage_key))).sort(), ["display.webp", "thumbnail.webp"]);
        else assert.ok(!(await readdir(storageRoot)).includes(row.storage_key));
      }
      assert.equal((await request(`/api/media/${readyId}/content`)).status, 404);
    });
  } catch (error) {
    const safe = new Error("MEDIA_HTTP_TEST_FAILED"); safe.stage = stage; safe.code = /^[A-Z0-9_]{1,30}$/.test(error?.code ?? "") ? error.code : "ERROR"; throw safe;
  } finally { await Promise.allSettled([owner.end(), maintenance.$disconnect()]); }
  return { passed, total: 17, secrets: [...secrets], username, password, ordinaryUsername, ordinaryPassword, readyId, readyDto };
}

export async function runMediaUploadHttpsTests({ origin, ca, backendOrigin, credentials, secrets }) {
  const { request } = transport(origin, secrets, ca);
  let passed = 0;
  const jar = {}, path = `/api/admin/media/${credentials.readyId}/content`;
  const login = await request("/api/auth/sign-in/username", { method: "POST", body: { username: credentials.username, password: credentials.password }, jar });
  assert.equal(login.status, 200); assert.ok(jar.cookie?.startsWith("__Secure-mq.session_token="));
  assert.ok(login.cookieLines.some(line => /; Secure(?:;|$)/i.test(line) && /; HttpOnly(?:;|$)/i.test(line)));
  assert.equal((await request(path)).status, 401); passed += 1;
  console.log("PASS media HTTPS: signed Secure cookie and guest denial use certificate-verified TLS");
  for (const method of ["GET", "HEAD"]) {
    const response = await request(path, { method, jar, headers: { "if-none-match": "*" } }); assert.equal(response.status, 200); privateHeaders(response);
    if (method === "GET") assert.equal(hash(response.bytes), credentials.readyDto.display.sha256); else assert.equal(response.bytes.length, 0);
  }
  passed += 1; console.log("PASS media HTTPS: authenticated GET/HEAD cannot turn private bytes into a 304 or cached response");
  const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: "#789abc" } }).png().toBuffer();
  const id = randomUUID();
  const uploaded = await request("/api/admin/media", { method: "POST", bytes: png, mime: "image/png", id, jar });
  assert.equal(uploaded.status, 201); privateHeaders(uploaded); assetDto(uploaded.data.asset);
  assert.equal(uploaded.data.asset.id, id); assert.equal(uploaded.data.asset.state, "READY");
  const content = await request(`/api/admin/media/${id}/content`, { jar });
  assert.equal(content.status, 200); privateHeaders(content);
  assert.equal(hash(content.bytes), uploaded.data.asset.display.sha256);
  assert.equal(content.bytes.length, uploaded.data.asset.display.byteLength);
  const metadata = await sharp(content.bytes).metadata();
  assert.equal(metadata.format, "webp"); assert.equal(metadata.width, 60); assert.equal(metadata.height, 40);
  passed += 1; console.log("PASS media HTTPS: actual PNG upload creates private WebP bytes with verified dimensions and hash");
  const bare = transport(backendOrigin, secrets).request;
  assert.equal((await bare(path, { jar })).status, 403);
  assert.equal((await request(path, { jar, requestOrigin: "https://attacker.invalid" })).status, 403);
  passed += 1; console.log("PASS media HTTPS: backend bypass and hostile Origin are refused");
  const copied = { ...jar };
  assert.equal((await request("/api/auth/sign-out", { method: "POST", body: {}, jar })).status, 200);
  assert.equal((await request(path, { jar: copied, method: "HEAD", headers: { "if-none-match": "*" } })).status, 401);
  passed += 1; console.log("PASS media HTTPS: logout rejects the copied Secure cookie before private HEAD access");
  return { passed, total: 5 };
}
