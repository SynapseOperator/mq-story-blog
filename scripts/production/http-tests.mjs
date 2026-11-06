import assert from "node:assert/strict";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

// The laboratory owns a random staging database and a loopback-only Caddy port.
// TLS is actually verified against Caddy's disposable CA; no global TLS bypass.
export function laboratoryTransport(origin, ca, secrets) {
  const target = new URL(origin);
  assert.equal(target.hostname, "mq.localhost");
  assert.equal(target.protocol, "https:");
  return (path, { method = "GET", body, bytes, jar, headers = {}, requestOrigin = origin } = {}) => new Promise((resolve, reject) => {
    const input = body === undefined ? bytes : Buffer.from(JSON.stringify(body));
    const request = https.request(new URL(path, origin), {
      method, ca, servername: "mq.localhost", timeout: 45000,
      lookup(_hostname, options, done) {
        if (options.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
        else done(null, "127.0.0.1", 4);
      },
      headers: { ...(requestOrigin === null ? {} : { origin: requestOrigin }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(input ? { "content-length": String(input.length) } : {}),
        ...(jar?.cookie ? { cookie: jar.cookie } : {}), ...headers },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk)); response.once("error", reject);
      response.once("end", () => {
        try {
          const buffer = Buffer.concat(chunks), text = buffer.toString("utf8");
          assert.ok([...secrets].every(secret => !secret || !text.includes(secret)), "response secret check");
          assert.ok(!/@accounts\.invalid|"(?:storageKey|storage_key|password|token|email)"\s*:/.test(text), "private field check");
          const cookieLines = response.headers["set-cookie"] ?? [];
          for (const line of cookieLines) if (jar && /^(?:__Secure-)?mq\.session_token=/.test(line)) {
            jar.cookie = /max-age=0(?:;|$)/i.test(line) ? "" : line.split(";", 1)[0];
            if (jar.cookie) secrets.add(jar.cookie);
          }
          resolve({ status: response.statusCode, headers: response.headers, bytes: buffer, text, cookieLines,
            data: /application\/json/.test(response.headers["content-type"] ?? "") && text ? JSON.parse(text) : null });
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject); request.once("timeout", () => request.destroy(new Error("LAB_HTTP_TIMEOUT")));
    request.end(input);
  });
}

export async function runProductionHttpChecks({ origin, ca, admin, reader, secrets, restart, revoke, directRequest, evidenceDirectory, operations }) {
  const request = laboratoryTransport(origin, ca, secrets), adminJar = {}, readerJar = {};
  const checks = [];
  let stage = "empty public catalog", story, asset, commentId;
  async function check(name, action) { stage = name; await action(); checks.push(name); console.log(`PASS staging: ${name}`); }
  const expect = (response, status) => { assert.equal(response.status, status, stage); return response; };
  const noStore = response => assert.match(response.headers["cache-control"] ?? "", /no-store/);
  const publication = async (action, extra = {}) => {
    const result = expect(await request(`/api/admin/stories/${story.id}/${action}`, {
      method: action === "slot" ? "PUT" : "POST", jar: adminJar, body: { expectedVersion: story.version, ...extra },
    }), 200);
    story = { ...story, ...result.data.story }; return result;
  };
  try {
    await check("empty catalog, anonymous administrator denial and real HTTPS", async () => {
      expect(await request("/"), 200);
      const empty = expect(await request("/api/stories"), 200); noStore(empty);
      assert.deepEqual(empty.data.stories, []);
      expect(await request("/api/admin/stories"), 401);
      expect(await request("/api/admin/media"), 401);
    });
    await check("ordinary registration, Secure Cookie and administrator login", async () => {
      expect(await request("/api/auth/sign-up/email", { method: "POST", body: reader, jar: readerJar }), 200);
      expect(await request("/api/admin/stories", { jar: readerJar }), 403);
      const login = expect(await request("/api/auth/sign-in/username", { method: "POST", body: admin, jar: adminJar }), 200);
      assert.ok(login.cookieLines.some(line => /^__Secure-mq\.session_token=/.test(line) && /; Secure/i.test(line) && /; HttpOnly/i.test(line)));
      assert.ok(adminJar.cookie && readerJar.cookie);
      expect(await request("/api/auth/get-session", { jar: adminJar }), 200);
    });
    await check("Caddy overwrites forged proxy headers and retains Origin checks", async () => {
      expect(await request("/api/admin/stories", { jar: adminJar, headers: {
        "x-mq-proxy-key": "forged", "x-mq-client-ip": "invalid", "x-mq-arbitrary": "injected", "x-forwarded-for": "203.0.113.99", forwarded: "for=203.0.113.99;proto=http",
      } }), 200);
      expect(await request("/api/admin/stories", { jar: adminJar, requestOrigin: "https://outside.invalid" }), 403);
      expect(await request("/api/auth/sign-in/username", { method: "POST", body: admin, requestOrigin: "https://outside.invalid" }), 403);
      // A request from another private container without the Caddy secret fails.
      assert.equal(await directRequest("/api/admin/stories"), 403);
      expect(await request("/api/auth/sign-in/username", { method: "POST", bytes: Buffer.alloc(8192, 32),
        headers: { "content-type": "application/json" } }), 413);
    });
    await check("private upload, real Sharp bytes and no public image before publication", async () => {
      const bytes = await sharp({ create: { width: 2100, height: 1100, channels: 3, background: "#617b95" } }).jpeg().toBuffer();
      const result = expect(await request("/api/admin/media", { method: "POST", jar: adminJar, bytes,
        headers: { "content-type": "image/jpeg", "idempotency-key": randomUUID() } }), 201);
      asset = result.data.asset; assert.equal(asset.state, "READY");
      assert.equal(asset.display.width, 1920);
      const content = expect(await request(`/api/admin/media/${asset.id}/content`, { jar: adminJar }), 200); noStore(content);
      assert.equal(createHash("sha256").update(content.bytes).digest("hex"), asset.display.sha256);
      assert.equal(content.bytes.length, asset.display.byteLength);
      expect(await request(`/api/admin/media/${asset.id}/content`, { method: "HEAD", headers: { "if-none-match": '"old"' } }), 401);
      expect(await request(`/api/admin/media/${asset.id}/content`, { jar: readerJar }), 403);
    });
    const title = "本地容器验收 · 合成图文故事";
    const content = { version: 2, blocks: [{ type: "paragraph", text: "本页仅使用隔离环境中的合成内容，验证真实 HTTPS 与私有图片访问。" },
      { type: "image", assetId: asset.id, alt: "合成蓝灰色图片", caption: "测试生成，不含私人照片" }] };
    await check("draft transaction, stable slot and signed publication under runtime role", async () => {
      story = expect(await request("/api/admin/stories", { method: "POST", jar: adminJar, body: { kind: "STAR", title, content } }), 201).data.story;
      expect(await request(`/api/stories/${story.id}`), 404);
      await publication("slot", { slotId: "star-1" }); await publication("publish");
      const detail = expect(await request(`/api/stories/${story.id}`), 200); assert.equal(detail.data.story.title, title);
      for (const method of ["GET", "HEAD"]) {
        const image = expect(await request(`/api/stories/${story.id}/media/${asset.id}`, { method, headers: { "if-none-match": '"old"' } }), 200);
        noStore(image); assert.equal(image.headers.etag, undefined);
      }
      for (const headers of [{}, { rsc: "1" }, { "user-agent": "Twitterbot/1.0" }]) {
        const shared = await request(`/stories/${story.slug}`, { headers });
        assert.ok([200, 307].includes(shared.status)); assert.ok(!shared.text.includes("storage_key"));
      }
    });
    await check("persistent likes and pending comments require signed administrator moderation", async () => {
      expect(await request(`/api/stories/${story.id}/likes`, { method: "PUT", body: {} }), 401);
      for (let i = 0; i < 2; i++) expect(await request(`/api/stories/${story.id}/likes`, { method: "PUT", body: {}, jar: readerJar }), 200);
      const key = randomUUID(), body = { body: "合成匿名留言：审核后才会公开。", identity: "anonymous" };
      const receipt = expect(await request(`/api/stories/${story.id}/comments`, { method: "POST", headers: { "idempotency-key": key }, body }), 202);
      commentId = receipt.data.receiptId;
      const repeat = expect(await request(`/api/stories/${story.id}/comments`, { method: "POST", headers: { "idempotency-key": key }, body }), 202);
      assert.equal(repeat.data.receiptId, commentId);
      assert.equal(expect(await request(`/api/stories/${story.id}/comments`), 200).data.count, 0);
      expect(await request(`/api/admin/comments/${commentId}/moderate`, { method: "POST", jar: adminJar, body: { action: "approve", expectedVersion: 0 } }), 200);
      assert.equal(expect(await request(`/api/stories/${story.id}/comments`), 200).data.count, 1);
    });
    await check("restart preserves database rows, image bytes and session behavior", async () => {
      await restart();
      expect(await request("/api/admin/stories", { jar: adminJar }), 200);
      assert.equal(expect(await request(`/api/stories/${story.id}/comments`), 200).data.count, 1);
      const image = expect(await request(`/api/stories/${story.id}/media/${asset.id}`), 200);
      assert.equal(createHash("sha256").update(image.bytes).digest("hex"), asset.display.sha256);
      assert.equal(expect(await request(`/api/stories/${story.id}/likes`, { jar: readerJar }), 200).data.count, 1);
    });
    await check("production browser desktop/mobile public reader and private workspace", async () => {
      await mkdir(evidenceDirectory, { recursive: true });
      const browser = await chromium.launch({ headless: true });
      try {
        for (const [name, viewport] of [["desktop", { width: 1536, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
          const context = await browser.newContext({ viewport, deviceScaleFactor: 2, ignoreHTTPSErrors: true,
            ...(name === "mobile" ? { isMobile: true, hasTouch: true, reducedMotion: "reduce" } : {}) });
          const page = await context.newPage(), errors = [];
          page.on("pageerror", () => errors.push("runtime"));
          page.on("console", message => { if (message.type() === "error") errors.push("console"); });
          expect(await page.goto(`${origin}/stories/${story.slug}`).then(response => ({ status: response.status() })), 200);
          await page.locator('dialog[data-phase="reading"]').waitFor({ timeout: 20000 });
          await page.getByRole("heading", { name: title, exact: true }).waitFor();
          const storyImage = page.getByRole("img", { name: "合成蓝灰色图片", exact: true });
          await storyImage.waitFor();
          await page.waitForFunction(image => image.complete && image.naturalWidth > 0,
            await storyImage.elementHandle(), { timeout: 20000 });
          await storyImage.evaluate(image => image.decode());
          assert.equal(await page.locator("nextjs-portal").count(), 0);
          assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
          await page.screenshot({ path: join(evidenceDirectory, `container-${name}.png`), scale: "device" });
          await page.goto(origin);
          await page.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
          const login = page.locator(".auth-dialog");
          await login.getByLabel("用户名", { exact: true }).fill(admin.username);
          await login.getByLabel("密码", { exact: true }).fill(admin.password);
          await login.locator(".auth-submit").click(); await login.waitFor({ state: "detached" });
          await page.goto(`${origin}/admin/stories?story=${story.id}`);
          await page.getByTestId("story-editor").waitFor();
          const titleInput = page.getByLabel("故事标题", { exact: true });
          await titleInput.waitFor(); assert.equal(await titleInput.inputValue(), title);
          assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
          await page.screenshot({ path: join(evidenceDirectory, `container-admin-${name}.png`), scale: "device" });
          assert.equal(errors.length, 0); await context.close();
        }
      } finally { await browser.close(); }
    });
    await check("withdraw/restore changes fresh public media access without losing history", async () => {
      await publication("withdraw");
      for (const method of ["GET", "HEAD"]) expect(await request(`/api/stories/${story.id}/media/${asset.id}`, { method }), 404);
      expect(await request(`/api/stories/${story.id}/comments`), 404);
      await publication("restore"); expect(await request(`/api/stories/${story.id}/media/${asset.id}`), 200);
    });
    if (operations) await check("encrypted restore and rotation preserve data while invalidating old authority", async () => {
      await operations({ story, asset, commentId, adminJar, readerJar, request });
      // Operations invalidates sessions intentionally. The final original
      // revocation regression still exercises a freshly authenticated account.
      expect(await request("/api/auth/sign-in/username", { method: "POST", body: admin, jar: adminJar }), 200);
    });
    await check("revocation invalidates the old administrator cookie immediately", async () => {
      await revoke(); expect(await request("/api/admin/stories", { jar: adminJar }), 401);
      expect(await request(`/api/admin/media/${asset.id}/content`, { method: "HEAD", jar: adminJar }), 401);
    });
    return { passed: checks.length, checks, storyId: story.id, assetId: asset.id, commentId };
  } catch { throw new Error(`STAGING_HTTP_FAILED:${stage}`); }
}
