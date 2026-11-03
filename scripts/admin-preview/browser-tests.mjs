import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { URL } from "node:url";

// The parent owns the isolated databases and synthetic accounts. Reports contain
// only test names and redacted diagnostic metadata, never request/response bodies.
export async function runBrowser({ baseURL, evidenceDirectory, admin, regular, privateCanaries, snapshotDatabase } = {}) {
  const origin = new URL(baseURL);
  assert.equal(origin.hostname, "127.0.0.1");
  assert.equal(origin.protocol, "https:");
  assert.equal(typeof snapshotDatabase, "function");
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MQ_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.MQ_PLAYWRIGHT_EXECUTABLE } : {}) });
  await mkdir(evidenceDirectory, { recursive: true });
  const report = { browser: browser.version(), origin: origin.origin, checkedAt: new Date().toISOString(),
    checks: [], screenshots: [], errors: [], passed: false };
  const contexts = [];
  let stage = "initialization", page, allowedFailure = false;
  const marker = `PRIVATE_PREVIEW_${randomUUID()}`;
  privateCanaries.push(marker);
  const initialTitle = "合成演示 · 把星光留在纸上";
  const initialBody = "合成演示：晚风轻轻经过山坡，远处的灯火渐渐亮起。我们把一个平常的夜晚写成书信，让每一段文字都有安静停留的地方。".repeat(6);
  const title = p => p.getByLabel("故事标题", { exact: true });
  const paragraphs = p => p.getByLabel("段落内容", { exact: true });
  const button = (p, name) => p.getByRole("button", { name, exact: true });
  const preview = p => p.locator('dialog[data-mode="private-preview"][open]');
  const digest = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
  async function check(name, action) {
    stage = name; await action(); report.checks.push({ name, passed: true });
    console.log(`PASS preview browser: ${name}`);
  }
  async function shot(p, name) {
    const file = `${name}.png`;
    await p.screenshot({ path: resolve(evidenceDirectory, file), fullPage: false, scale: "css",
      mask: await p.locator('input[type="password"]').all() });
    report.screenshots.push(file);
  }
  async function newContext(viewport, extra = {}) {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, ...extra });
    contexts.push(context);
    const p = await context.newPage(); p.setDefaultTimeout(15_000); page = p;
    p.on("pageerror", error => report.errors.push({ kind: "pageerror", fingerprint: digest(error.message) }));
    p.on("console", message => {
      if (["warning", "error"].includes(message.type()) && !allowedFailure)
        report.errors.push({ kind: message.type(), fingerprint: digest(message.text()) });
    });
    return p;
  }
  async function login(p, account) {
    assert.equal((await p.goto(baseURL, { waitUntil: "domcontentloaded" })).status(), 200);
    await p.waitForFunction(() => !globalThis.document.querySelector(".account-controls button")?.disabled);
    await p.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
    const dialog = p.locator(".auth-dialog");
    await dialog.getByLabel("用户名", { exact: true }).fill(account.username);
    await dialog.getByLabel("密码", { exact: true }).fill(account.password);
    await dialog.locator(".auth-submit").click(); await dialog.waitFor({ state: "detached" });
    await p.locator(".account-username").waitFor();
  }
  async function editor(p) {
    assert.equal((await p.goto(`${baseURL}/admin/stories`, { waitUntil: "domcontentloaded" })).status(), 200);
    await p.getByTestId("story-editor").waitFor();
    assert.equal(await p.locator("nextjs-portal").count(), 0);
  }
  async function state(p, value) {
    await p.waitForFunction(value => globalThis.document.querySelector('[data-testid="editor-status"]')?.getAttribute("data-state") === value, value);
  }
  async function localState(p) {
    return p.evaluate(() => ({ url: globalThis.location.href, history: JSON.stringify(globalThis.history.state), length: globalThis.history.length,
      local: JSON.stringify(globalThis.localStorage), session: JSON.stringify(globalThis.sessionStorage) }));
  }
  async function open(p, expected, dirty = true) {
    await button(p, "预览羽毛信").click();
    const dialog = preview(p); await dialog.waitFor();
    await p.locator('dialog[data-mode="private-preview"][data-phase="reading"]').waitFor();
    await dialog.getByText("管理员私有预览 · 未发布", { exact: true }).waitFor();
    if (dirty) await dialog.getByText("包含未保存修改", { exact: false }).waitFor();
    if (expected) assert.ok((await dialog.textContent()).includes(expected));
    assert.equal(await dialog.locator("#letter-comment").count(), 0);
    assert.equal(await dialog.getByRole("button", { name: /点赞|留言|登录|分享/ }).count(), 0);
  }
  async function close(p) {
    await button(p, "关闭预览").click(); await preview(p).waitFor({ state: "detached" });
  }
  async function noWrites(p, action) {
    const before = await snapshotDatabase(), stateBefore = await localState(p);
    const writes = [];
    const observe = request => { if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(new URL(request.url()).pathname); };
    p.on("request", observe);
    try { await action(); } finally { p.off("request", observe); }
    assert.deepEqual(writes, []);
    assert.deepEqual(await snapshotDatabase(), before);
    assert.deepEqual(await localState(p), stateBefore);
  }
  async function read(p, path, headers = {}) {
    return p.evaluate(async ({ path, headers }) => {
      const response = await globalThis.fetch(path, { credentials: "omit", cache: "no-store", headers });
      return { status: response.status, text: await response.text() };
    }, { path, headers });
  }
  try {
    const guest = await newContext({ width: 1536, height: 1024 });
    await check("anonymous and ordinary users cannot access private editor", async () => {
      allowedFailure = true;
      await guest.goto(baseURL, { waitUntil: "domcontentloaded" });
      const denied = await read(guest, `${baseURL}/api/admin/stories`); assert.equal(denied.status, 401);
      await login(guest, regular);
      const response = await guest.evaluate(async () => { const r = await globalThis.fetch('/api/admin/stories'); return r.status; });
      assert.equal(response, 403);
      await guest.goto(`${baseURL}/admin/stories`); assert.equal(await guest.getByTestId("story-editor").count(), 0);
      allowedFailure = false;
    });
    const desktop = await newContext({ width: 1536, height: 1024 });
    await login(desktop, admin); await editor(desktop);
    await check("new unsaved STAR previews snapshot without writes or browser state changes", async () => {
      await button(desktop, "新建故事").click();
      await title(desktop).fill(initialTitle); await paragraphs(desktop).first().fill(initialBody);
      await noWrites(desktop, async () => {
        await open(desktop, "合成演示：晚风"); await shot(desktop, "desktop-new-preview");
        await close(desktop);
      });
      assert.equal(await title(desktop).inputValue(), initialTitle);
    });
    await check("structured paragraphs and images preserve order, styles, alt and captions", async () => {
      await desktop.getByLabel("段落样式", { exact: true }).first().selectOption("emphasis");
      await button(desktop, "添加段落").click(); await paragraphs(desktop).nth(1).fill("合成加粗段落");
      await desktop.getByLabel("段落样式", { exact: true }).nth(1).selectOption("strong");
      await desktop.getByTestId("content-block").nth(1).getByRole("button", { name: "上移", exact: true }).click();
      for (let i = 0; i < 2; i++) {
        await button(desktop, "添加图片").click();
        await desktop.getByLabel("图片说明（供无障碍阅读）", { exact: true }).nth(i).fill(`合成配图${i + 1}`);
        await desktop.getByLabel("图片题注", { exact: true }).nth(i).fill(`合成题注${i + 1}`);
      }
      await noWrites(desktop, async () => {
        await open(desktop, "合成加粗段落");
        const text = await preview(desktop).textContent();
        assert.ok(text.indexOf("合成加粗段落") < text.indexOf("合成演示：晚风"));
        assert.equal(await preview(desktop).locator("strong").filter({ hasText: "合成加粗段落" }).count(), 1);
        assert.equal(await preview(desktop).locator("em").filter({ hasText: "合成演示：晚风" }).count(), 1);
        for (let i = 1; i <= 2; i++) {
          assert.equal(await preview(desktop).getByAltText(`合成配图${i}`).count(), 1);
          assert.ok(text.includes(`合成题注${i}`));
        }
        await shot(desktop, "desktop-structured-preview"); await close(desktop);
      });
    });
    await check("failed synthetic images show fallback without preventing reading or closing", async () => {
      const handler = route => route.abort("failed");
      allowedFailure = true;
      await desktop.route("**/scene/night-sky.webp", handler);
      try {
        await noWrites(desktop, async () => {
          await open(desktop, "合成演示：晚风");
          await preview(desktop).locator(".letter-image-fallback").first().waitFor();
          assert.ok((await preview(desktop).textContent()).includes("合成加粗段落"));
          await shot(desktop, "desktop-image-fallback"); await close(desktop);
        });
      } finally { await desktop.unroute("**/scene/night-sky.webp", handler); allowedFailure = false; }
    });
    let storyId, slug;
    await check("saved draft and later local changes preview without version or revision change", async () => {
      await button(desktop, "保存草稿").click(); await state(desktop, "saved");
      storyId = new URL(desktop.url()).searchParams.get("story"); assert.match(storyId ?? "", /^[a-f0-9-]{36}$/i);
      const detail = await desktop.evaluate(async id => (await (await globalThis.fetch(`/api/admin/stories/${id}/draft`)).json()), storyId);
      slug = detail.story.slug;
      await title(desktop).fill(`${marker} 未保存修改`);
      await noWrites(desktop, async () => { await open(desktop, `${marker} 未保存修改`); await close(desktop); });
      assert.equal(await title(desktop).inputValue(), `${marker} 未保存修改`); await state(desktop, "dirty");
    });
    await check("anonymous public endpoints and share HTML, RSC and metadata exclude preview canary", async () => {
      allowedFailure = true;
      const paths = ["/api/stories", `/api/stories/${storyId}`, `/api/stories/by-slug/${slug}`, `/stories/${slug}`];
      for (const path of paths) {
        for (const headers of [{}, ...(path.startsWith("/stories/") ? [{ RSC: "1" }] : [])]) {
          const response = await read(desktop, path, headers);
          assert.ok(!response.text.includes(marker));
          if (path.startsWith("/api/stories/")) assert.equal(response.status, 404);
        }
      }
      const bot = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: "Twitterbot/1.0" });
      contexts.push(bot);
      const metadata = await bot.request.get(`${baseURL}/stories/${slug}`);
      assert.equal(metadata.status(), 200);
      const html = await metadata.text();
      assert.ok(!html.includes(marker)); assert.ok(html.includes("故事暂不可用"));
      allowedFailure = false;
    });
    await check("preview while a committed save awaits acknowledgement keeps newer local input dirty", async () => {
      const path = `/api/admin/stories/${storyId}/draft`;
      let release, observed;
      const gate = new Promise(resolve => { release = resolve; });
      const committed = new Promise(resolve => { observed = resolve; });
      const handler = async route => {
        if (route.request().method() !== "PUT") return route.continue();
        const response = await route.fetch(); assert.equal(response.status(), 200); observed(); await gate;
        await route.fulfill({ response });
      };
      await desktop.route(`${baseURL}${path}`, handler);
      try {
        await button(desktop, "保存草稿").click(); await committed; await state(desktop, "saving");
        await title(desktop).fill(`${marker} 保存中继续编辑`);
        await noWrites(desktop, async () => {
          await open(desktop, "保存中继续编辑");
          const dialog = await preview(desktop).elementHandle();
          const scroll = preview(desktop).locator(".letter-scroll");
          await scroll.evaluate(element => { element.scrollTop = 150; });
          const scrollTop = await scroll.evaluate(element => element.scrollTop);
          assert.ok(scrollTop > 0);
          release(); await state(desktop, "dirty");
          assert.equal(await dialog.evaluate(element => element === globalThis.document.querySelector('dialog[data-mode="private-preview"]')), true);
          assert.equal(await scroll.evaluate(element => element.scrollTop), scrollTop);
          assert.ok((await preview(desktop).textContent()).includes("保存中继续编辑"));
          await close(desktop);
        });
        assert.equal(await title(desktop).inputValue(), `${marker} 保存中继续编辑`);
      } finally { release(); await desktop.unroute(`${baseURL}${path}`, handler); }
    });
    await check("preview after real concurrent version conflict preserves unsaved input and conflict state", async () => {
      const path = `/api/admin/stories/${storyId}/draft`;
      const concurrent = await desktop.evaluate(async path => {
        const current = await (await globalThis.fetch(path)).json();
        const response = await globalThis.fetch(path, { method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedVersion: current.story.version, title: current.draft.title, content: current.draft.content }) });
        return response.status;
      }, path);
      assert.equal(concurrent, 200);
      allowedFailure = true;
      const conflictResponse = desktop.waitForResponse(response => new URL(response.url()).pathname === path
        && response.request().method() === "PUT");
      await button(desktop, "保存草稿").click(); assert.equal((await conflictResponse).status(), 409); await state(desktop, "conflict");
      await noWrites(desktop, async () => { await open(desktop, "保存中继续编辑"); await close(desktop); });
      await state(desktop, "conflict");
      assert.equal(await title(desktop).inputValue(), `${marker} 保存中继续编辑`);
      allowedFailure = false;
    });
    await check("preview after an unknown network result retains local input and uncertain state", async () => {
      await button(desktop, "读取服务器版本").click();
      await button(desktop, "保留本地并继续编辑").click();
      const path = `/api/admin/stories/${storyId}/draft`;
      const handler = route => route.request().method() === "PUT" ? route.abort("failed") : route.continue();
      allowedFailure = true; await desktop.route(`${baseURL}${path}`, handler);
      try { await button(desktop, "保存草稿").click(); await state(desktop, "uncertain"); }
      finally { await desktop.unroute(`${baseURL}${path}`, handler); }
      await noWrites(desktop, async () => { await open(desktop, "保存中继续编辑"); await close(desktop); });
      await state(desktop, "uncertain");
      assert.equal(await title(desktop).inputValue(), `${marker} 保存中继续编辑`);
      allowedFailure = false;
    });
    await check("blurred input then window scroll restores current scroll, focus and backward selection", async () => {
      const field = paragraphs(desktop).first();
      await field.scrollIntoViewIfNeeded();
      await field.focus(); await field.evaluate(el => el.setSelectionRange(1, 4, "backward"));
      const selection = await field.evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection]);
      const originalScroll = await desktop.evaluate(() => globalThis.scrollY);
      await button(desktop, "添加图片").focus();
      await desktop.evaluate(() => globalThis.scrollTo(0, 0));
      const scroll = await desktop.evaluate(() => globalThis.scrollY);
      assert.ok(originalScroll > scroll);
      await noWrites(desktop, async () => {
        await open(desktop, marker); await desktop.keyboard.press("Escape"); await preview(desktop).waitFor({ state: "detached" });
        await field.waitFor({ state: "visible" });
        await desktop.waitForFunction(() => globalThis.document.activeElement?.getAttribute("aria-label") === "段落内容");
        assert.deepEqual(await field.evaluate(el => [el.selectionStart, el.selectionEnd, el.selectionDirection]), selection);
        assert.ok(Math.abs((await desktop.evaluate(() => globalThis.scrollY)) - scroll) <= 1);
      });
    });
    await check("rapid activation produces one dialog; backdrop and repeated open close work", async () => {
      await noWrites(desktop, async () => {
        await button(desktop, "预览羽毛信").evaluate(element => { element.click(); element.click(); });
        await desktop.locator('dialog[data-mode="private-preview"][data-phase="reading"]').waitFor();
        assert.equal(await preview(desktop).count(), 1);
        await desktop.mouse.click(1, 1); await preview(desktop).waitFor({ state: "detached" });
        await open(desktop, marker); await close(desktop);
      });
    });
    await check("empty new CAMPFIRE can be previewed without saving", async () => {
      await button(desktop, "新建篝火").click();
      await desktop.getByRole("dialog").getByRole("button", { name: "放弃并离开", exact: true }).click();
      await noWrites(desktop, async () => { await open(desktop, null, false); await shot(desktop, "desktop-empty-campfire"); await close(desktop); });
    });
    for (const variant of [
      { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      { name: "narrow-reduced", viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" },
    ]) {
      const device = await newContext(variant.viewport, { isMobile: variant.isMobile, hasTouch: variant.hasTouch, reducedMotion: variant.reducedMotion });
      await login(device, admin); await editor(device);
      await check(`${variant.name}: unsaved preview fits viewport and closes without mutation`, async () => {
        await button(device, "新建故事").click(); await title(device).fill("合成演示 · 山坡上的晚风");
        await paragraphs(device).first().fill("合成演示：夜色落在安静的山坡上，星光与篝火陪着这封信。我们把平凡的时刻一字一句写下来，留给未来的自己慢慢阅读。".repeat(12));
        await noWrites(device, async () => {
          await open(device, "合成演示：夜色");
          assert.equal(await device.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
          const box = await preview(device).locator(".letter-sheet").boundingBox();
          assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= variant.viewport.width + 1 && box.y + box.height <= variant.viewport.height + 1);
          await shot(device, `${variant.name}-preview`);
          const beforeWindow = await device.evaluate(() => globalThis.scrollY);
          const scroll = preview(device).locator(".letter-scroll");
          await scroll.evaluate(element => { element.scrollTop = 200; });
          assert.ok(await scroll.evaluate(element => element.scrollTop) > 0);
          assert.equal(await device.evaluate(() => globalThis.scrollY), beforeWindow);
          if (variant.reducedMotion === "reduce") {
            assert.equal(await device.evaluate(() => globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches), true);
            assert.equal(await preview(device).evaluate(element => globalThis.getComputedStyle(element).animationName), "none");
          }
          await close(device);
        });
      });
    }
    assert.equal(report.errors.length, 0); report.passed = true;
  } catch (error) {
    report.failedAt = stage;
    report.failure = { kind: ["AssertionError", "TimeoutError", "Error"].includes(error?.name) ? error.name : "Error",
      source: /browser-tests\.mjs:\d+:\d+/.exec(error?.stack ?? "")?.[0] ?? "unknown" };
    if (page && !page.isClosed()) await shot(page, "failure").catch(() => {});
    throw new Error(`Preview browser failed at ${stage}; sensitive details withheld`, { cause: error });
  } finally {
    await Promise.allSettled(contexts.map(context => context.close())); await browser.close();
    await writeFile(resolve(evidenceDirectory, "preview-browser-results.json"), JSON.stringify(report, null, 2));
  }
  console.log(`Preview browser: ${report.checks.length} checks passed; ${report.screenshots.length} screenshots`);
}
