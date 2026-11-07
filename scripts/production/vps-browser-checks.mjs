import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";

// Run on the trusted workstation, through a loopback SSH tunnel. No server
// password, private key, database URL or Docker socket is accepted here.
export function validateVpsFixture(value) {
  assert.ok(value?.version === 1 && value.synthetic === true, "VPS_SYNTHETIC_FIXTURE_REQUIRED");
  const target = new URL(value.origin);
  assert.equal(target.protocol, "https:"); assert.equal(target.hostname, "mq.localhost");
  assert.ok(Number(target.port) >= 1024 && Number(target.port) <= 65535);
  assert.equal(target.origin, value.origin);
  assert.ok(!target.username && !target.password && !target.search && !target.hash);
  assert.match(value.ca ?? "", /^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/);
  for (const name of ["admin", "reader"]) {
    const account = value.accounts?.[name];
    assert.match(account?.username ?? "", new RegExp(`^lab_${name}_[a-f0-9]{8}$`));
    assert.ok(typeof account.password === "string" && account.password.length >= 24 && account.password.length <= 256);
    assert.ok(!/[\r\n\0]/.test(account.password));
  }
  assert.notEqual(value.accounts.admin.password, value.accounts.reader.password);
  return value;
}

async function privateJson(path) {
  const metadata = await lstat(path);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.size < 128 * 1024);
  // Windows ACL is established by the local SSH helper, not POSIX mode bits.
  if (process.platform !== "win32") assert.equal(metadata.mode & 0o077, 0);
  return JSON.parse(await readFile(path, "utf8"));
}

const publicTitle = "VPS 隔离验收 · 星光里的合成来信";
const campfireTitle = "VPS 隔离验收 · 我们在一起的故事";
const draftTitle = "未发布修改 · 只能在管理员编辑器中出现";
const privateTitle = "完全私有的合成图片草稿";
const imageAlt = "用于 VPS 验收的合成蓝灰色图片";

async function browserChecks(fixture, state, evidenceDirectory, phase) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true,
    args: ["--host-resolver-rules=MAP mq.localhost 127.0.0.1"] });
  const screenshots = [];
  try {
    for (const [name, viewport] of [["desktop", { width: 1536, height: 1024 }],
      ["mobile", { width: 390, height: 844 }], ["narrow", { width: 320, height: 568 }]]) {
      // Only this disposable local CA gets a browser-context exception. HTTP
      // tests separately verify the actual chain using the exported CA.
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, ignoreHTTPSErrors: true,
        ...(name !== "desktop" ? { isMobile: true, hasTouch: true, reducedMotion: "reduce" } : {}) });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", () => errors.push("runtime"));
      page.on("console", message => { if (message.type() === "error") errors.push("console"); });
      const shot = async label => {
        assert.equal(await page.locator("nextjs-portal").count(), 0);
        assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
        const file = `vps-${phase}-${name}-${label}.png`;
        await page.screenshot({ path: join(evidenceDirectory, file), scale: "device" }); screenshots.push(file);
      };
      const reading = async title => {
        await page.locator('dialog[data-phase="reading"]').waitFor({ timeout: 30000 });
        await page.getByRole("heading", { name: title, exact: true }).waitFor();
      };
      assert.equal((await page.goto(fixture.origin)).status(), 200);
      assert.match(await page.title(), /MQ/);
      const star = page.getByRole("button", { name: `故事：${publicTitle}`, exact: true });
      const fire = page.getByRole("button", { name: `故事：${campfireTitle}`, exact: true });
      await star.waitFor(); await fire.waitFor(); await shot("scene");
      await star.click(); await reading(publicTitle);
      assert.equal(new URL(page.url()).pathname, `/stories/${state.story.slug}`);
      await page.getByRole("button", { name: "关闭羽毛信", exact: true }).click();
      await page.locator(".letter-dialog[open]").waitFor({ state: "detached" });
      await fire.click(); await reading(campfireTitle);
      await page.keyboard.press("Escape");
      await page.locator(".letter-dialog[open]").waitFor({ state: "detached" });
      assert.equal((await page.goto(`${fixture.origin}/stories/${state.story.slug}`)).status(), 200);
      await reading(publicTitle);
      const image = page.getByRole("img", { name: imageAlt, exact: true });
      await image.waitFor(); await image.evaluate(element => element.decode());
      assert.ok(await image.evaluate(element => element.naturalWidth > 0));
      assert.equal(await page.getByText(draftTitle, { exact: true }).count(), 0);
      await shot("letter");

      // Login stays nested in this same reader. No comment is submitted by UI.
      const draft = "未提交 · SSH 隧道合成验收留言";
      const composer = page.getByLabel("留言内容", { exact: true });
      await composer.fill(draft);
      await page.locator('.letter-reactions[data-state="ready"]').waitFor();
      const scroller = page.locator(".letter-scroll");
      const loginTrigger = page.locator(".reader-account").getByRole("button", { name: "登录账号", exact: true });
      // Measure after Playwright has scrolled the trigger into view; its own
      // pre-click scrolling must not be mistaken for a reader regression.
      await loginTrigger.scrollIntoViewIfNeeded();
      const scrollTop = await scroller.evaluate(element => element.scrollTop);
      await loginTrigger.click();
      const login = page.locator(".auth-dialog");
      await login.getByLabel("用户名", { exact: true }).fill(fixture.accounts.admin.username);
      await login.getByLabel("密码", { exact: true }).fill(fixture.accounts.admin.password);
      await login.locator(".auth-submit").click(); await login.waitFor({ state: "detached" });
      assert.equal(await composer.inputValue(), draft);
      assert.ok(Math.abs(await scroller.evaluate(element => element.scrollTop) - scrollTop) <= 3);
      await page.getByRole("button", { name: "关闭羽毛信", exact: true }).click();
      await page.getByRole("button", { name: "继续编辑", exact: true }).click();
      assert.equal(await composer.inputValue(), draft);
      await composer.fill("");
      await page.getByRole("button", { name: "关闭羽毛信", exact: true }).click();
      await page.locator(".letter-dialog[open]").waitFor({ state: "detached" });
      await page.goto(`${fixture.origin}/admin/stories?story=${state.story.id}`);
      await page.getByTestId("story-editor").waitFor({ timeout: 30000 });
      const titleInput = page.getByLabel("故事标题", { exact: true });
      await titleInput.waitFor();
      await page.waitForFunction(({ input, expected }) => input.value === expected,
        { input: await titleInput.elementHandle(), expected: draftTitle });
      assert.equal(await titleInput.inputValue(), draftTitle);
      await page.locator('[data-testid="publication-status"][data-state="PUBLISHED"]').waitFor();
      const publication = page.getByRole("region", { name: "发布管理", exact: true });
      if (phase === "after-restore") {
        await publication.locator(".publication-unavailable").waitFor();
      } else {
        // The title and publication controls load independently. Wait for the
        // real slot response rather than capturing a transient loading panel.
        const assignedSlot = publication.getByRole("radio", { name: "星位 1", exact: true });
        await assignedSlot.waitFor({ timeout: 30000 });
        await publication.locator('.publication-read-state[role="status"]').waitFor({ state: "hidden" });
        assert.equal(await publication.locator('[role="alert"]').count(), 0);
        assert.equal(await assignedSlot.isChecked(), true);
      }
      await shot("editor");
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); }
  return screenshots;
}

/** Each phase must be run explicitly. A failure retains the private checkpoint;
 * the script never blindly retries POST, resumes initialization or deletes data. */
export async function runVpsBrowserChecks({ phase, fixturePath, statePath, evidenceDirectory }) {
  assert.ok(["before", "resume-browser", "after-recreate", "after-restore"].includes(phase), "VPS_CHECK_PHASE_REJECTED");
  const fixture = validateVpsFixture(await privateJson(resolve(fixturePath)));
  const targetState = resolve(statePath);
  assert.equal(dirname(targetState), dirname(resolve(fixturePath)), "VPS_STATE_LOCATION_REJECTED");
  await mkdir(evidenceDirectory, { recursive: true });
  const state = phase === "before" ? { version: 1, synthetic: true, origin: fixture.origin, adminJar: {}, readerJar: {}, checks: [] }
    : await privateJson(targetState);
  assert.ok(state.version === 1 && state.synthetic === true && state.origin === fixture.origin);
  if (phase === "before") await writeFile(targetState, JSON.stringify(state), { flag: "wx", mode: 0o600 });
  else if (phase === "resume-browser") assert.equal(state.beforeHttpPassed, true, "VPS_BUSINESS_CHECKPOINT_REQUIRED");
  else assert.equal(state.beforePassed, true, "VPS_INITIAL_CHECKS_REQUIRED");
  const { laboratoryTransport } = await import("./http-tests.mjs");
  const secrets = new Set([fixture.accounts.admin.password, fixture.accounts.reader.password]);
  for (const jar of [state.adminJar, state.readerJar]) if (jar.cookie) secrets.add(jar.cookie);
  const request = laboratoryTransport(fixture.origin, fixture.ca, secrets);
  const expect = (response, status) => { assert.equal(response.status, status); return response; };
  const noStore = response => assert.match(response.headers["cache-control"] ?? "", /no-store/);
  let stage = "begin", screenshots = [];
  const check = async (name, action) => {
    stage = name; await action(); state.checks.push(`${phase}:${name}`);
    await writeFile(targetState, JSON.stringify(state), { mode: 0o600 });
    console.log(`PASS VPS ${phase}: ${name}`);
  };
  const publication = async (story, action, extra = {}) => ({ ...story, ...expect(await request(`/api/admin/stories/${story.id}/${action}`, {
    method: action === "slot" ? "PUT" : "POST", jar: state.adminJar,
    body: { expectedVersion: story.version, ...extra },
  }), 200).data.story });
  const assertPublic = async () => {
    const publicStory = expect(await request(`/api/stories/${state.story.id}`), 200);
    assert.equal(publicStory.data.story.title, publicTitle); assert.ok(!publicStory.text.includes(draftTitle));
    expect(await request(`/api/stories/${state.privateStory.id}`), 404);
    for (const method of ["GET", "HEAD"]) {
      const asset = expect(await request(`/api/stories/${state.story.id}/media/${state.asset.id}`, {
        method, headers: { "if-none-match": '"previous"', "if-modified-since": new Date().toUTCString() },
      }), 200);
      noStore(asset); assert.equal(asset.headers.etag, undefined);
      if (method === "GET") {
        assert.equal(createHash("sha256").update(asset.bytes).digest("hex"), state.asset.display.sha256);
        assert.equal(asset.bytes.length, state.asset.display.byteLength);
      }
      expect(await request(`/api/stories/${state.story.id}/media/${state.privateAsset.id}`, { method }), 404);
      expect(await request(`/api/stories/${state.privateStory.id}/media/${state.privateAsset.id}`, { method }), 404);
      expect(await request(`/api/admin/media/${state.privateAsset.id}/content`, { method }), 401);
    }
    assert.equal(expect(await request(`/api/stories/${state.story.id}/comments`), 200).data.count, 2);
    assert.equal(expect(await request(`/api/stories/${state.story.id}/likes`), 200).data.count, 1);
    for (const headers of [{}, { rsc: "1" }, { "user-agent": "Twitterbot/1.0" }]) {
      const shared = await request(`/stories/${state.story.slug}`, { headers });
      assert.ok([200, 307].includes(shared.status)); assert.ok(!shared.text.includes(draftTitle));
      const hidden = await request(`/stories/${state.privateStory.slug}`, { headers });
      assert.ok(!hidden.text.includes(privateTitle));
    }
  };
  try {
    if (phase === "before") {
      await check("empty catalog and guest boundaries", async () => {
        expect(await request("/"), 200);
        const empty = expect(await request("/api/stories"), 200); noStore(empty); assert.deepEqual(empty.data.stories, []);
        expect(await request("/api/admin/stories"), 401); expect(await request("/api/admin/media"), 401);
      });
      await check("synthetic registration and session origin boundaries", async () => {
        expect(await request("/api/auth/sign-up/email", { method: "POST", body: fixture.accounts.reader, jar: state.readerJar }), 200);
        expect(await request("/api/admin/stories", { jar: state.readerJar }), 403);
        const login = expect(await request("/api/auth/sign-in/username", {
          method: "POST", body: fixture.accounts.admin, jar: state.adminJar,
        }), 200);
        assert.ok(login.cookieLines.some(line => /^__Secure-mq\.session_token=/.test(line) && /; Secure/i.test(line) && /; HttpOnly/i.test(line)));
        expect(await request("/api/admin/stories", { jar: state.adminJar, headers: {
          "x-mq-proxy-key": "forged", "x-mq-client-ip": "invalid", forwarded: "for=203.0.113.99", "x-forwarded-for": "203.0.113.99",
        } }), 200);
        expect(await request("/api/admin/stories", { jar: state.adminJar, requestOrigin: "https://outside.invalid" }), 403);
        expect(await request("/api/auth/sign-in/username", { method: "POST", body: fixture.accounts.admin, requestOrigin: "https://outside.invalid" }), 403);
      });
      await check("two private synthetic uploads and real image hashes", async () => {
        const { default: sharp } = await import("sharp");
        for (const [key, color] of [["asset", "#617b95"], ["privateAsset", "#a98b6f"]]) {
          const bytes = await sharp({ create: { width: 2100, height: 1100, channels: 3, background: color } }).jpeg().toBuffer();
          state[key] = expect(await request("/api/admin/media", { method: "POST", jar: state.adminJar, bytes,
            headers: { "content-type": "image/jpeg", "idempotency-key": randomUUID() } }), 201).data.asset;
          assert.equal(state[key].state, "READY"); assert.equal(state[key].display.width, 1920);
          const image = expect(await request(`/api/admin/media/${state[key].id}/content`, { jar: state.adminJar }), 200);
          noStore(image); assert.equal(createHash("sha256").update(image.bytes).digest("hex"), state[key].display.sha256);
          expect(await request(`/api/admin/media/${state[key].id}/content`, { jar: state.readerJar }), 403);
        }
      });
      await check("star and campfire publication with private draft isolation", async () => {
        const content = { version: 2, blocks: [{ type: "paragraph", text: "本页仅为香港 VPS 的隔离合成验收，不是真实情侣故事。" },
          { type: "image", assetId: state.asset.id, alt: imageAlt, caption: "合成素材 · 不含私人照片" }] };
        state.story = expect(await request("/api/admin/stories", { method: "POST", jar: state.adminJar,
          body: { kind: "STAR", title: publicTitle, content } }), 201).data.story;
        expect(await request(`/api/stories/${state.story.id}`), 404);
        state.story = await publication(state.story, "slot", { slotId: "star-1" });
        state.story = await publication(state.story, "publish");
        state.story = expect(await request(`/api/admin/stories/${state.story.id}/draft`, { method: "PUT", jar: state.adminJar,
          body: { expectedVersion: state.story.version, title: draftTitle, content: { version: 2, blocks: [
            { type: "paragraph", text: "这段未发布修改不能进入公开正文。" }, { type: "image", assetId: state.privateAsset.id, alt: "未发布的合成图片" },
          ] } } }), 200).data.story;
        state.privateStory = expect(await request("/api/admin/stories", { method: "POST", jar: state.adminJar,
          body: { kind: "STAR", title: privateTitle, content: { version: 2, blocks: [
            { type: "paragraph", text: "完全私有的合成草稿。" }, { type: "image", assetId: state.privateAsset.id, alt: "仅管理员可见" },
          ] } } }), 201).data.story;
        state.campfire = expect(await request("/api/admin/stories", { method: "POST", jar: state.adminJar,
          body: { kind: "CAMPFIRE", title: campfireTitle, content: { version: 1, blocks: [
            { type: "paragraph", text: "这是一篇合成篝火文章，用于确认首页篝火与羽毛信绑定。" },
          ] } } }), 201).data.story;
        state.campfire = await publication(state.campfire, "publish");
      });
      await check("persistent idempotent likes and moderated anonymous and account comments", async () => {
        expect(await request(`/api/stories/${state.story.id}/likes`, { method: "PUT", body: {} }), 401);
        for (let i = 0; i < 2; i++) expect(await request(`/api/stories/${state.story.id}/likes`, { method: "PUT", body: {}, jar: state.readerJar }), 200);
        state.commentIds = [];
        for (const identity of ["anonymous", "account"]) {
          const key = randomUUID(), body = { body: `VPS 合成${identity === "anonymous" ? "匿名" : "账号"}留言，审核后公开。`, identity };
          const options = { method: "POST", headers: { "idempotency-key": key }, body, ...(identity === "account" ? { jar: state.readerJar } : {}) };
          const receipt = expect(await request(`/api/stories/${state.story.id}/comments`, options), 202).data;
          if (identity === "anonymous") assert.equal(expect(await request(`/api/stories/${state.story.id}/comments`, options), 202).data.receiptId, receipt.receiptId);
          state.commentIds.push(receipt.receiptId);
        }
        assert.equal(expect(await request(`/api/stories/${state.story.id}/comments`), 200).data.count, 0);
        for (const id of state.commentIds) expect(await request(`/api/admin/comments/${id}/moderate`, {
          method: "POST", jar: state.adminJar, body: { action: "approve", expectedVersion: 0 },
        }), 200);
      });
      await check("published revision image and HTML RSC metadata boundaries", assertPublic);
      await check("withdraw and restore retain original published revision", async () => {
        state.story = await publication(state.story, "withdraw");
        for (const method of ["GET", "HEAD"]) expect(await request(`/api/stories/${state.story.id}/media/${state.asset.id}`, { method }), 404);
        expect(await request(`/api/stories/${state.story.id}/comments`), 404);
        state.story = await publication(state.story, "restore"); await assertPublic();
      });
      state.beforeHttpPassed = true;
      await writeFile(targetState, JSON.stringify(state), { mode: 0o600 });
      await check("desktop mobile and narrow browser workflows", async () => {
        screenshots = await browserChecks(fixture, state, evidenceDirectory, phase);
      });
      state.beforePassed = true;
    } else if (phase === "resume-browser") {
      // The prior HTTP writes are not replayed. Browser login still creates a
      // synthetic session, but no registration/upload/story/comment is repeated.
      await check("existing business checkpoint still has the expected public data", assertPublic);
      await check("desktop mobile and narrow browser workflows", async () => {
        screenshots = await browserChecks(fixture, state, evidenceDirectory, phase);
      });
      state.beforePassed = true;
    } else if (phase === "after-recreate") {
      await check("recreated containers preserve rows files and sessions", async () => {
        await assertPublic(); expect(await request("/api/admin/stories", { jar: state.adminJar }), 200);
        assert.equal(expect(await request(`/api/stories/${state.story.id}/likes`, { jar: state.readerJar }), 200).data.liked, true);
      });
      await check("recreated desktop mobile and narrow browser workflows", async () => {
        screenshots = await browserChecks(fixture, state, evidenceDirectory, phase);
      });
      state.recreatePassed = true;
    } else {
      await check("restore preserves data and invalidates old sessions", async () => {
        await assertPublic(); expect(await request("/api/admin/stories", { jar: state.adminJar }), 401);
        assert.equal(expect(await request(`/api/stories/${state.story.id}/likes`, { jar: state.readerJar }), 200).data.liked, false);
        state.restoredAdminJar = {};
        expect(await request("/api/auth/sign-in/username", { method: "POST", body: fixture.accounts.admin, jar: state.restoredAdminJar }), 200);
        expect(await request("/api/admin/stories", { jar: state.restoredAdminJar }), 200);
        expect(await request(`/api/admin/media/${state.privateAsset.id}/content`, { jar: state.restoredAdminJar }), 200);
        expect(await request(`/api/admin/stories/${state.story.id}/withdraw`, { method: "POST", jar: state.restoredAdminJar,
          body: { expectedVersion: state.story.version } }), 503);
        expect(await request(`/api/stories/${state.story.id}/comments`, { method: "POST", headers: { "idempotency-key": randomUUID() },
          body: { body: "恢复后未重新授权的合成留言", identity: "anonymous" } }), 503);
      });
      await check("restored desktop mobile and narrow browser workflows", async () => {
        screenshots = await browserChecks(fixture, state, evidenceDirectory, phase);
      });
      await check("logout immediately invalidates the previous cookie", async () => {
        const previous = { cookie: state.restoredAdminJar.cookie };
        expect(await request("/api/auth/sign-out", { method: "POST", body: {}, jar: state.restoredAdminJar }), 200);
        expect(await request("/api/admin/stories", { jar: previous }), 401);
      });
      state.restorePassed = true;
    }
    await writeFile(targetState, JSON.stringify(state), { mode: 0o600 });
    const result = { phase, passed: true, synthetic: true, productionDeployed: false,
      checks: state.checks.filter(value => value.startsWith(`${phase}:`)), screenshots,
      ...(phase === "resume-browser" ? { priorBusinessCheckpointReused: true, businessWritesReplayed: false } : {}),
      browserPath: "Browser plugin not available; existing Playwright through SSH tunnel" };
    await writeFile(join(evidenceDirectory, `vps-${phase}-result.json`), JSON.stringify(result, null, 2));
    return result;
  } catch {
    state.failedStage = `${phase}:${stage}`;
    await writeFile(targetState, JSON.stringify(state), { mode: 0o600 });
    throw new Error(`VPS_CHECK_FAILED:${phase}:${stage}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 6);
    const [phase, fixturePath, statePath, evidenceDirectory] = process.argv.slice(2);
    console.log(JSON.stringify(await runVpsBrowserChecks({ phase, fixturePath, statePath, evidenceDirectory })));
  } catch (error) {
    console.error(/^VPS_CHECK_FAILED:[a-z-]+:[a-z ]+$/.test(error.message) ? error.message : "VPS_CHECK_CONFIGURATION_REJECTED");
    process.exitCode = 1;
  }
}
