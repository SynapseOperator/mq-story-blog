import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import sharp from "sharp";
import { chromium } from "playwright";

// The media integration runner owns the isolated PostgreSQL database, synthetic
// identities and TLS. No cookies, passwords, HAR or database content are saved.
export async function runBrowser({ baseURL, admin, regular, publicStory, privateAssetId,
  snapshotDatabase, evidenceDirectory }) {
  assert.equal(new URL(baseURL).hostname, "127.0.0.1");
  assert.equal(new URL(baseURL).protocol, "https:");
  assert.equal(typeof snapshotDatabase, "function");
  await mkdir(evidenceDirectory, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MQ_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.MQ_PLAYWRIGHT_EXECUTABLE } : {}) });
  const contexts = [], report = { browser: browser.version(), checks: [], screenshots: [], errors: [], expectedFailures: [], passed: false };
  const secrets = [admin.password, regular.password];
  let stage = "initialize", currentPage, expectedFailure = false;
  const title = page => page.getByLabel("故事标题", { exact: true });
  const body = page => page.getByLabel("段落内容", { exact: true });
  const button = (page, name) => page.getByRole("button", { name, exact: true });
  const panel = page => page.getByRole("dialog", { name: "选择故事图片", exact: true });
  const preview = page => page.locator('dialog[data-mode="private-preview"][open]');
  const fingerprint = text => createHash("sha256").update(text).digest("hex").slice(0, 16);
  async function check(name, action) {
    stage = name; await action(); report.checks.push(name); console.log(`PASS managed media browser: ${name}`);
  }
  async function shot(page, name) {
    const file = `${name}.png`;
    await page.screenshot({ path: resolve(evidenceDirectory, file), scale: "css", fullPage: false,
      mask: await page.locator('input[type="password"]').all() });
    report.screenshots.push(file);
  }
  async function makePage(viewport, extra = {}) {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, ...extra }); contexts.push(context);
    const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(15_000);
    page.on("pageerror", error => report.errors.push({ kind: "runtime", fingerprint: fingerprint(error.message) }));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      (expectedFailure ? report.expectedFailures : report.errors).push({ kind: message.type(), fingerprint: fingerprint(message.text()) });
    });
    return page;
  }
  async function api(page, path, { method = "GET", data, anonymous = false } = {}) {
    const result = await page.evaluate(async ({ path, method, data, anonymous }) => {
      const response = await globalThis.fetch(path, { method, cache: "no-store", credentials: anonymous ? "omit" : "same-origin",
        ...(data === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(data) }) });
      const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, text, data: json };
    }, { path, method, data, anonymous });
    assert.ok(!/@accounts\.invalid|"(?:storageKey|token|email|password)"\s*:/.test(result.text));
    assert.ok(secrets.every(secret => !result.text.includes(secret)));
    return result;
  }
  async function login(page, account) {
    assert.equal((await page.goto(baseURL)).status(), 200);
    await page.waitForFunction(() => !globalThis.document.querySelector(".account-controls button")?.disabled);
    await page.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
    const dialog = page.locator(".auth-dialog");
    await dialog.getByLabel("用户名", { exact: true }).fill(account.username);
    await dialog.getByLabel("密码", { exact: true }).fill(account.password);
    await dialog.locator(".auth-submit").click(); await dialog.waitFor({ state: "detached" });
    await page.locator(".account-username").waitFor();
  }
  async function editor(page, id) {
    assert.equal((await page.goto(`${baseURL}/admin/stories${id ? `?story=${id}` : ""}`)).status(), 200);
    await page.getByTestId("story-editor").waitFor();
    assert.match(await page.title(), /MQ/); assert.equal(await page.locator("nextjs-portal").count(), 0);
    if (id) await title(page).waitFor();
  }
  async function status(page, value) {
    await page.waitForFunction(value => globalThis.document.querySelector('[data-testid="editor-status"]')?.getAttribute("data-state") === value, value);
  }
  async function showPreview(page) {
    await button(page, "预览羽毛信").click(); await preview(page).waitFor();
    await page.locator('dialog[data-mode="private-preview"][data-phase="reading"]').waitFor();
    assert.equal(await preview(page).getByRole("button", { name: /点赞|登录|留言|分享/ }).count(), 0);
  }
  async function imageReady(locator) {
    await locator.waitFor(); await locator.evaluate(image => image.decode());
    assert.ok(await locator.evaluate(image => image.naturalWidth > 0 && image.naturalHeight > 0));
  }
  async function openPicker(page) {
    await button(page, "上传或选择图片").click(); await panel(page).waitFor();
    const box = await panel(page).boundingBox(), viewport = page.viewportSize();
    assert.ok(Math.abs(box.x + box.width / 2 - viewport.width / 2) < 2);
    assert.ok(Math.abs(box.y + box.height / 2 - viewport.height / 2) < 2);
  }
  async function visibleThumbnails(page) {
    await page.waitForFunction(() => {
      const pane = globalThis.document.querySelector(".editor-media-scroll");
      if (!pane) return false;
      const bounds = pane.getBoundingClientRect();
      const images = [...pane.querySelectorAll("img")].filter(image => {
        const box = image.getBoundingClientRect(); return box.bottom > bounds.top && box.top < bounds.bottom;
      });
      return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0);
    });
  }
  async function choose(page, id) {
    await panel(page).getByRole("button", { name: `选择图片 ${id}`, exact: true }).click();
    await button(panel(page), "插入图片").click(); await panel(page).waitFor({ state: "detached" });
  }
  // Synthetic raster built in memory, never a real photograph or persisted input.
  const width = 900, height = 600, pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3, hill = y > 420 + 45 * Math.sin(x / 160);
    const star = y < 330 && (x * 31 + y * 97) % 2017 < 2;
    pixels[at] = star ? 244 : hill ? 27 : 25 + y / 9;
    pixels[at + 1] = star ? 218 : hill ? 55 : 40 + y / 11;
    pixels[at + 2] = star ? 170 : hill ? 46 : 74 + y / 9;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const uploadFile = { name: "synthetic-evening.png", mimeType: "image/png", buffer: png };
  try {
    const guest = await makePage({ width: 1536, height: 1024 });
    await check("guest and ordinary sessions cannot read private managed images or editor data", async () => {
      await guest.goto(baseURL); expectedFailure = true;
      assert.equal((await api(guest, `/api/admin/media/${privateAssetId}`)).status, 401);
      await login(guest, regular);
      assert.equal((await api(guest, `/api/admin/media/${privateAssetId}`)).status, 403);
      await guest.goto(`${baseURL}/admin/stories`); assert.equal(await guest.getByTestId("story-editor").count(), 0);
      expectedFailure = false;
    });
    const page = await makePage({ width: 1536, height: 1024 }); await login(page, admin); await editor(page);
    let uploadedId, storyId;
    const headline = "合成故事 · 把晚风写进信里";
    await check("real image upload and explicit insertion change only the current working document", async () => {
      await button(page, "新建故事").click(); await title(page).fill(headline);
      await body(page).first().fill("这是一段合成验收文字。远处的星光映着山坡，我们用一张生成的配图，记录一个并未真实发生的夜晚。".repeat(3));
      const before = await snapshotDatabase();
      await openPicker(page); await panel(page).getByLabel("选择要上传的图片", { exact: true }).setInputFiles(uploadFile);
      await page.locator('[data-testid="media-upload-status"][data-state="ready"]').waitFor();
      const media = await api(page, "/api/admin/media?limit=50");
      assert.equal(media.status, 200);
      const originalIds = new Set([privateAssetId]);
      const newImage = media.data.items.find(asset => asset.state === "READY" && asset.display.width === width && !originalIds.has(asset.id));
      assert.ok(newImage); uploadedId = newImage.id;
      await choose(page, uploadedId);
      await page.getByLabel("图片说明（供无障碍阅读）", { exact: true }).last().fill("合成星空与草坡配图");
      await page.getByLabel("图片题注", { exact: true }).last().fill("合成素材 · 仅用于图文功能验收");
      await status(page, "dirty"); assert.deepEqual(await snapshotDatabase(), before);
      await shot(page, "desktop-managed-editor");
      await openPicker(page); await panel(page).getByText(/当前用于 \d+ 篇公开故事/).first().waitFor();
      await visibleThumbnails(page);
      await shot(page, "desktop-media-library"); await page.keyboard.press("Escape"); await panel(page).waitFor({ state: "detached" });
    });
    await check("unsaved private feather-letter uses managed images without revisions, URL or storage writes", async () => {
      const before = await snapshotDatabase(), address = page.url();
      const storage = await page.evaluate(() => ({ local: JSON.stringify(globalThis.localStorage), session: JSON.stringify(globalThis.sessionStorage) }));
      await showPreview(page); await imageReady(preview(page).getByAltText("合成星空与草坡配图"));
      assert.ok((await preview(page).getByAltText("合成星空与草坡配图").getAttribute("src")).startsWith(`/api/admin/media/${uploadedId}/content`));
      await shot(page, "desktop-private-managed-letter"); await page.keyboard.press("Escape"); await preview(page).waitFor({ state: "detached" });
      assert.equal(page.url(), address); await status(page, "dirty"); assert.deepEqual(await snapshotDatabase(), before);
      assert.deepEqual(await page.evaluate(() => ({ local: JSON.stringify(globalThis.localStorage), session: JSON.stringify(globalThis.sessionStorage) })), storage);
    });
    await check("only explicit manual save creates a v2 revision and asset reference; refresh reloads it", async () => {
      await button(page, "保存草稿").click(); await status(page, "saved");
      storyId = new URL(page.url()).searchParams.get("story"); assert.ok(storyId);
      const saved = await api(page, `/api/admin/stories/${storyId}/draft`); assert.equal(saved.status, 200);
      assert.equal(saved.data.draft.content.version, 2);
      assert.ok(saved.data.draft.content.blocks.some(block => block.assetId === uploadedId));
      assert.ok(!saved.data.draft.content.blocks.some(block => block.type === "image" && "src" in block));
      await page.reload(); await title(page).waitFor(); assert.equal(await title(page).inputValue(), headline); await status(page, "saved");
    });
    await check("a committed upload with lost response is reconciled by the original ID without a second POST", async () => {
      let uploads = 0, unknownId;
      const handler = async route => {
        if (route.request().method() !== "POST") return route.continue();
        uploads++; unknownId = route.request().headers()["idempotency-key"];
        const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort("failed");
      };
      expectedFailure = true; await page.route(`${baseURL}/api/admin/media`, handler);
      try {
        await openPicker(page); await panel(page).getByLabel("选择要上传的图片", { exact: true }).setInputFiles(uploadFile);
        await page.locator('[data-testid="media-upload-status"][data-state="uncertain"]').waitFor();
        await panel(page).getByRole("button", { name: /查询.*状态|核对.*状态/ }).click();
        await page.locator('[data-testid="media-upload-status"][data-state="ready"]').waitFor();
        assert.equal(uploads, 1); assert.equal((await api(page, `/api/admin/media/${unknownId}`)).data.asset.state, "READY");
        await page.keyboard.press("Escape"); await panel(page).waitFor({ state: "detached" }); await status(page, "saved");
      } finally { await page.unroute(`${baseURL}/api/admin/media`, handler); expectedFailure = false; }
    });
    await check("503 and real concurrent 409 preserve local v2 images and allow private preview", async () => {
      const draftPath = `/api/admin/stories/${storyId}/draft`, localTitle = "合成草稿 · 保存失败仍保留配图";
      await title(page).fill(localTitle);
      const handler = route => route.request().method() === "PUT"
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "ADMIN_UNAVAILABLE" }), headers: { "cache-control": "private, no-store" } }) : route.continue();
      expectedFailure = true; await page.route(`${baseURL}${draftPath}`, handler);
      await button(page, "保存草稿").click(); await status(page, "uncertain"); await page.unroute(`${baseURL}${draftPath}`, handler);
      assert.equal(await title(page).inputValue(), localTitle); await showPreview(page); await imageReady(preview(page).getByAltText("合成星空与草坡配图"));
      await button(page, "关闭预览").click(); await preview(page).waitFor({ state: "detached" });
      await button(page, "读取服务器版本").click(); await button(page, "保留本地并继续编辑").click();
      const detail = (await api(page, draftPath)).data;
      assert.equal((await api(page, draftPath, { method: "PUT", data: { expectedVersion: detail.story.version, title: "合成并发胜者", content: detail.draft.content } })).status, 200);
      await button(page, "保存草稿").click(); await status(page, "conflict"); assert.equal(await title(page).inputValue(), localTitle);
      await showPreview(page); await imageReady(preview(page).getByAltText("合成星空与草坡配图")); await shot(page, "desktop-conflict-preview");
      await button(page, "关闭预览").click(); await preview(page).waitFor({ state: "detached" });
      expectedFailure = false;
    });
    for (const [name, viewport, extra] of [
      ["mobile", { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
      ["narrow-reduced", { width: 320, height: 568 }, { isMobile: true, hasTouch: true, reducedMotion: "reduce" }],
    ]) {
      await check(`${name} managed private preview, selector and editor remain usable`, async () => {
        const mobile = await makePage(viewport, extra); await login(mobile, admin); await editor(mobile, storyId);
        await showPreview(mobile); await imageReady(preview(mobile).getByAltText("合成星空与草坡配图"));
        await preview(mobile).getByAltText("合成星空与草坡配图").scrollIntoViewIfNeeded(); await shot(mobile, `${name}-private-managed-letter`);
        await button(mobile, "关闭预览").click(); await preview(mobile).waitFor({ state: "detached" });
        await openPicker(mobile); await panel(mobile).getByRole("button", { name: `选择图片 ${privateAssetId}`, exact: true }).waitFor();
        await visibleThumbnails(mobile);
        await shot(mobile, `${name}-media-library`);
        assert.ok(await mobile.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        await mobile.keyboard.press("Escape"); await panel(mobile).waitFor({ state: "detached" });
      });
    }
    await check("delayed save ACK confirms the sent draft only while newer text and selected media stay dirty", async () => {
      const editing = await makePage({ width: 1536, height: 1024 }); await login(editing, admin); await editor(editing);
      await button(editing, "新建故事").click();
      const sentTitle = "合成保存快照 · 发出时的标题", sentText = "合成发送正文，不含后来选择的图片。";
      const localTitle = "合成保存快照 · 请求中继续编辑";
      await title(editing).fill(sentTitle); await body(editing).first().fill(sentText);
      let release, received, rejected;
      const held = new Promise(resolve => { release = resolve; });
      const committed = new Promise((resolve, reject) => { received = resolve; rejected = reject; });
      const handler = async route => {
        if (route.request().method() !== "POST") return route.continue();
        try {
          const response = await route.fetch();
          received({ status: response.status(), data: await response.json() });
          await held; await route.fulfill({ response });
        } catch (error) { rejected(error); }
      };
      await editing.route(`${baseURL}/api/admin/stories`, handler);
      try {
        await button(editing, "保存草稿").click();
        const accepted = await committed; assert.equal(accepted.status, 201);
        await status(editing, "saving");
        await title(editing).fill(localTitle); await body(editing).first().fill("合成后续正文：保存中继续输入，并明确选择一张图片。");
        await openPicker(editing); await choose(editing, privateAssetId);
        await editing.getByLabel("图片说明（供无障碍阅读）", { exact: true }).last().fill("保存请求发出后才选择的合成图片");
        await status(editing, "saving");
        const beforeAck = await api(editing, `/api/admin/stories/${accepted.data.story.id}/draft`);
        assert.equal(beforeAck.status, 200); assert.equal(beforeAck.data.draft.title, sentTitle);
        assert.equal(beforeAck.data.draft.content.blocks[0].text, sentText);
        assert.equal(beforeAck.data.draft.content.blocks.filter(block => block.type === "image").length, 0);
        release(); await status(editing, "dirty");
        assert.equal(await title(editing).inputValue(), localTitle);
        assert.equal(await editing.locator(`.editor-image-block img[src="/api/admin/media/${privateAssetId}/content"]`).count(), 1);
        assert.equal(new URL(editing.url()).searchParams.get("story"), accepted.data.story.id);
        assert.equal((await api(editing, `/api/admin/stories/${accepted.data.story.id}/draft`)).data.draft.title, sentTitle);
        assert.equal(await button(editing, "保存草稿").isEnabled(), true);
      } finally { release(); await editing.unroute(`${baseURL}/api/admin/stories`, handler); }
    });
    await check("legacy v1 images survive mixed editing and save as v2 only after explicit replacement", async () => {
      const editing = await makePage({ width: 1536, height: 1024 }); await login(editing, admin);
      const created = await api(editing, "/api/admin/stories", { method: "POST", data: {
        kind: "STAR", title: "合成旧图迁移 · 明确替换", content: { version: 1, blocks: [
          { type: "paragraph", text: "合成旧稿。原图必须保留，直到管理员明确选择替换。" },
          { type: "image", src: "/scene/night-sky.webp", alt: "应当保留的旧合成图片", caption: "原有合成题注" },
        ] },
      } });
      assert.equal(created.status, 201);
      const path = `/api/admin/stories/${created.data.story.id}/draft`;
      await editor(editing, created.data.story.id); await status(editing, "saved");
      await openPicker(editing); await choose(editing, privateAssetId);
      await editing.getByLabel("图片说明（供无障碍阅读）", { exact: true }).last().fill("新增合成素材说明");
      assert.equal(await button(editing, "保存草稿").isDisabled(), true);
      assert.match(await editing.locator(".editor-validation").textContent(), /逐一替换/);
      assert.equal(await editing.locator('.editor-image-block img[src="/scene/night-sky.webp"]').count(), 1);
      assert.equal(await editing.getByLabel("图片说明（供无障碍阅读）", { exact: true }).first().inputValue(), "应当保留的旧合成图片");
      const unchanged = await api(editing, path);
      assert.equal(unchanged.data.story.version, 0); assert.equal(unchanged.data.draft.content.version, 1);
      assert.equal(unchanged.data.draft.content.blocks[1].src, "/scene/night-sky.webp");
      await editing.locator(".editor-image-block").first().getByRole("button", { name: "替换图片", exact: true }).click();
      await panel(editing).getByRole("button", { name: `选择图片 ${privateAssetId}`, exact: true }).click();
      await button(panel(editing), "替换图片").click(); await panel(editing).waitFor({ state: "detached" });
      assert.equal(await editing.getByLabel("图片说明（供无障碍阅读）", { exact: true }).first().inputValue(), "应当保留的旧合成图片");
      assert.equal(await editing.getByLabel("图片题注", { exact: true }).first().inputValue(), "原有合成题注");
      assert.equal(await editing.locator('.editor-image-block img[src="/scene/night-sky.webp"]').count(), 0);
      assert.equal(await button(editing, "保存草稿").isEnabled(), true);
      await button(editing, "保存草稿").click(); await status(editing, "saved");
      const saved = await api(editing, path);
      assert.equal(saved.data.story.version, 1); assert.equal(saved.data.draft.content.version, 2);
      const images = saved.data.draft.content.blocks.filter(block => block.type === "image");
      assert.equal(images.length, 2); assert.ok(images.every(image => image.assetId === privateAssetId && !Object.hasOwn(image, "src")));
    });
    await check("late media confirmation cannot insert into another editor after closing the picker", async () => {
      const editing = await makePage({ width: 1536, height: 1024 }); await login(editing, admin); await editor(editing);
      await button(editing, "新建故事").click(); await title(editing).fill("合成旧编辑器 · 等待图片确认");
      await body(editing).first().fill("合成内容，用于核对迟到的图片确认结果。");
      const before = await snapshotDatabase();
      let release, received, rejected;
      const held = new Promise(resolve => { release = resolve; });
      const checked = new Promise((resolve, reject) => { received = resolve; rejected = reject; });
      const path = `${baseURL}/api/admin/media/${privateAssetId}`;
      const handler = async route => {
        try {
          const response = await route.fetch(); received(response.status());
          await held; await route.fulfill({ response });
        } catch (error) { rejected(error); }
      };
      await editing.route(path, handler);
      try {
        await openPicker(editing); await panel(editing).getByRole("button", { name: `选择图片 ${privateAssetId}`, exact: true }).click();
        await button(panel(editing), "插入图片").click(); assert.equal(await checked, 200);
        await editing.keyboard.press("Escape"); await panel(editing).waitFor({ state: "detached" });
        await button(editing, "新建故事").click();
        await editing.locator(".editor-leave-dialog").getByRole("button", { name: "放弃并离开", exact: true }).click();
        await title(editing).fill("合成新编辑器 · 不接收旧图片"); await body(editing).first().fill("新草稿保持这一段，没有选择图片。");
        const delivered = editing.waitForResponse(response => response.url() === path && response.status() === 200);
        release(); await delivered;
        await editing.waitForFunction(() => globalThis.document.querySelector(".editor-media-insert")?.textContent === "插入图片");
        assert.equal(await title(editing).inputValue(), "合成新编辑器 · 不接收旧图片");
        assert.equal(await body(editing).first().inputValue(), "新草稿保持这一段，没有选择图片。");
        assert.equal(await editing.locator(".editor-image-block").count(), 0);
        assert.equal(await editing.getByTestId("content-block").count(), 1);
        await status(editing, "dirty"); assert.deepEqual(await snapshotDatabase(), before);
      } finally { release(); await editing.unroute(path, handler); }
    });
    await check("anonymous shared v2 article renders managed image and supports refresh and fallback retry", async () => {
      const publicPage = await makePage({ width: 1536, height: 1024 });
      const path = `/stories/${publicStory.slug}`; await publicPage.goto(`${baseURL}${path}`);
      const letter = publicPage.locator('dialog[data-mode="public"][open]'); await letter.waitFor();
      const img = letter.locator('img[src^="/api/stories/"]').first(); await imageReady(img);
      assert.ok((await img.getAttribute("src")).startsWith(`/api/stories/${publicStory.id}/media/`));
      await img.scrollIntoViewIfNeeded(); await shot(publicPage, "desktop-public-managed-letter");
      await publicPage.reload(); await imageReady(publicPage.locator('img[src^="/api/stories/"]').first());
      assert.equal(publicPage.url(), `${baseURL}${path}`);
      expectedFailure = true;
      await publicPage.route("**/api/stories/*/media/*", route => route.abort("failed")); await publicPage.reload();
      await publicPage.locator(".letter-image-fallback").first().waitFor();
      assert.ok((await publicPage.locator(".letter-prose").textContent()).length > 0);
      await publicPage.unroute("**/api/stories/*/media/*");
      await publicPage.getByRole("button", { name: "重试图片", exact: true }).first().click();
      await imageReady(publicPage.locator('img[src^="/api/stories/"]').first()); expectedFailure = false;
      await button(publicPage, "关闭羽毛信").click();
      await letter.waitFor({ state: "detached" }); assert.equal(new URL(publicPage.url()).pathname, "/");
      await publicPage.locator(`.story-entry--star[data-story-id="${publicStory.id}"]`).click();
      await imageReady(publicPage.locator('img[src^="/api/stories/"]').first());
      const historyLength = await publicPage.evaluate(() => globalThis.history.length);
      await publicPage.goBack(); await letter.waitFor({ state: "detached" });
      assert.equal(new URL(publicPage.url()).pathname, "/");
      await publicPage.goForward(); await imageReady(publicPage.locator('img[src^="/api/stories/"]').first());
      assert.equal(new URL(publicPage.url()).pathname, path);
      assert.equal(await publicPage.evaluate(() => globalThis.history.length), historyLength);
      await publicPage.locator("#letter-comment").fill("合成留言 · 图文历史切换保留输入");
      await publicPage.goBack();
      await publicPage.locator(".letter-discard").getByRole("button", { name: "继续编辑", exact: true }).click();
      await publicPage.waitForURL(`${baseURL}${path}`);
      assert.equal(await publicPage.locator("#letter-comment").inputValue(), "合成留言 · 图文历史切换保留输入");
      assert.equal(await publicPage.evaluate(() => globalThis.history.length), historyLength);
      await button(publicPage, "关闭羽毛信").click();
      await publicPage.locator(".letter-discard").getByRole("button", { name: "放弃并关闭", exact: true }).click();
      await letter.waitFor({ state: "detached" }); assert.equal(new URL(publicPage.url()).pathname, "/");
    });
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) {
    if (currentPage) await shot(currentPage, "failure-synthetic-page").catch(() => {});
    const safe = new Error("MEDIA_STORY_BROWSER_FAILED"); safe.stage = stage;
    const location = /story-browser-tests\.mjs:(\d+):(\d+)/.exec(error?.stack ?? "");
    if (location) safe.stage += ` [browser test line ${location[1]}:${location[2]}]`;
    if (typeof error?.actual === "number" && typeof error?.expected === "number") {
      safe.stage += ` [numeric actual=${error.actual}, expected=${error.expected}]`;
    }
    safe.code = error?.code === "ERR_ASSERTION" ? "ERR_ASSERTION" : error?.name === "TimeoutError" ? "TIMEOUT" : "ERROR";
    throw safe;
  } finally {
    await Promise.allSettled(contexts.map(context => context.close())); await browser.close();
    await writeFile(resolve(evidenceDirectory, "browser-results.json"), JSON.stringify(report, null, 2));
  }
  return { passed: report.checks.length, screenshots: report.screenshots.length };
}
