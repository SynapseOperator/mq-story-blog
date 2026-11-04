import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { revokeAdmin } from "../../src/server/admin/maintenance.ts";
import { assertTemporaryTarget } from "../admin-drafts/test-support.mjs";

/** Runs only after the original publication/restore tests. Real UI writes use
 * the restricted application; owner access observes rows and injects failures. */
export async function runPublishingEditorBrowser({ baseURL, connectionString, maintenanceUrl,
  storageRoot, admin, regular, assets, privateValues, evidenceDirectory }) {
  assertTemporaryTarget(connectionString); assertTemporaryTarget(maintenanceUrl);
  assert.equal(new URL(baseURL).hostname, "127.0.0.1");
  assert.equal(new URL(baseURL).protocol, "https:");
  const owner = new pg.Pool({ connectionString, max: 2 });
  const maintenance = createAuthDatabaseClient(maintenanceUrl);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MQ_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.MQ_PLAYWRIGHT_EXECUTABLE } : {}) });
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
  const contexts = [], report = { browser: browser.version(), browserPath: "Browser plugin not available; locked Playwright Chromium",
    scope: "P2-10B real publishing management with isolated synthetic data", checks: [], screenshots: [], errors: [], expectedFailures: [], passed: false };
  let stage = "setup", activePage;
  const allowed = new Set(), writes = [];
  const secrets = [admin.password, regular.password];
  const pathOf = value => new URL(value, baseURL).pathname;
  const fingerprint = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
  const button = (page, name) => page.getByRole("button", { name, exact: true });
  const title = page => page.getByLabel("故事标题", { exact: true });
  const panel = page => page.getByRole("region", { name: "发布管理", exact: true });
  const path = (id, action) => `/api/admin/stories/${id}/${action}`;
  const current = async id => (await owner.query("SELECT * FROM story WHERE id=$1", [id])).rows[0];
  const check = async (name, action) => { stage = name; await action(); report.checks.push(name); console.log(`PASS publication editor browser: ${name}`); };
  async function api(page, url, { method = "GET", data, anonymous = false, headers = {} } = {}) {
    const result = await page.evaluate(async ({ url, method, data, anonymous, headers }) => {
      const response = await globalThis.fetch(url, { method, cache: "no-store", credentials: anonymous ? "omit" : "same-origin",
        headers: { ...headers, ...(data === undefined ? {} : { "content-type": "application/json" }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const text = await response.text(); let json = null;
      try { json = JSON.parse(text); } catch { /* HTML/RSC and images need no JSON parsing. */ }
      return { status: response.status, text, data: json, cache: response.headers.get("cache-control") };
    }, { url, method, data, anonymous, headers });
    assert.ok(!/@accounts\.invalid|"(?:storageKey|token|email|password|signature|publishedRevisionId)"\s*:/.test(result.text));
    for (const secret of secrets) assert.ok(!result.text.includes(secret));
    return result;
  }
  async function makePage(name, viewport, extra = {}) {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, ...extra }); contexts.push(context);
    const page = await context.newPage(); activePage = page; page.setDefaultTimeout(20_000);
    page.on("pageerror", error => report.errors.push({ kind: "runtime", view: name, fingerprint: fingerprint(error.message) }));
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      const target = pathOf(message.location().url || baseURL);
      (allowed.has(target) ? report.expectedFailures : report.errors).push({ kind: message.type(), view: name, path: target,
        fingerprint: fingerprint(message.text()) });
    });
    page.on("response", response => {
      if (response.status() < 400) return;
      const target = pathOf(response.url());
      (allowed.has(target) ? report.expectedFailures : report.errors).push({ kind: "http", path: target, status: response.status() });
    });
    page.on("request", request => {
      const target = pathOf(request.url());
      if (!/^\/api\/admin\/stories\/[^/]+\/(slot|publish|withdraw|restore)$/.test(target) || !["POST", "PUT"].includes(request.method())) return;
      let data;
      try { data = request.postDataJSON(); } catch { report.errors.push({ kind: "invalid-publication-body", path: target }); return; }
      const expected = target.endsWith("/slot") ? ["expectedVersion", "slotId"] : ["expectedVersion"];
      if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(expected.sort())) report.errors.push({ kind: "unexpected-publication-fields", path: target });
      writes.push(target);
    });
    return page;
  }
  async function login(page, account) {
    activePage = page;
    await page.goto(baseURL); await page.waitForFunction(() => !globalThis.document.querySelector(".account-controls button")?.disabled);
    await page.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
    const dialog = page.locator(".auth-dialog");
    await dialog.getByLabel("用户名", { exact: true }).fill(account.username);
    await dialog.getByLabel("密码", { exact: true }).fill(account.password);
    await dialog.locator(".auth-submit").click(); await dialog.waitFor({ state: "detached" });
    assert.ok((await page.context().cookies()).some(cookie => cookie.name === "__Secure-mq.session_token" && cookie.secure && cookie.httpOnly));
    // Keep every new synthetic token in the parent's Node-only log audit, even
    // though the final revocation removes those session rows before cleanup.
    const rows = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
    rows.forEach(row => privateValues.add(row.value));
  }
  async function editor(page, id) {
    activePage = page;
    await page.goto(`${baseURL}/admin/stories${id ? `?story=${id}` : ""}`);
    await page.getByTestId("story-editor").waitFor();
    if (id) await title(page).waitFor();
  }
  async function status(page, value) {
    await page.waitForFunction(value => globalThis.document.querySelector('[data-testid="editor-status"]')?.getAttribute("data-state") === value, value);
  }
  async function save(page) {
    await button(page, "保存草稿").click(); await status(page, "saved");
    return new URL(page.url()).searchParams.get("story");
  }
  async function publication(page, id, state) {
    const row = await current(id);
    assert.equal(row.state, state);
    await page.waitForFunction(({ state, version }) => {
      const node = globalThis.document.querySelector('[data-testid="publication-status"]');
      return node?.getAttribute("data-state") === state && node?.getAttribute("data-version") === String(version);
    }, { state, version: row.version });
    return row;
  }
  async function mutate(page, id, action, label) {
    activePage = page;
    const response = page.waitForResponse(response => pathOf(response.url()) === path(id, action) && response.request().method() !== "GET");
    await button(page, label).click(); assert.equal((await response).status(), 200);
    return publication(page, id, action === "withdraw" ? "WITHDRAWN" : action === "slot" ? "DRAFT" : "PUBLISHED");
  }
  async function reconcile(page) {
    await button(page, "读取服务器版本").click();
    await button(page, "保留本地并继续编辑").click();
  }
  async function screenshot(page, name) {
    if (!evidenceDirectory) return;
    const file = `${name}.png`;
    await page.screenshot({ path: resolve(evidenceDirectory, file), scale: "css", fullPage: false,
      mask: await page.locator('input[type="password"]').all() });
    report.screenshots.push(file);
  }
  async function settledEditor(page, id) {
    // A publication ACK precedes the list and slot GETs. Capture their completed
    // state, including the matching list version, rather than an intermediate UI.
    await page.waitForFunction(id => {
      const publication = globalThis.document.querySelector('[data-testid="publication-status"]');
      const item = globalThis.document.querySelector(`[data-testid="draft-row"][data-story-id="${id}"] .editor-draft-meta`);
      const controls = ["刷新草稿列表", "刷新星位"].map(name =>
        [...globalThis.document.querySelectorAll("button")].find(button => button.textContent.trim() === name));
      return publication && item?.textContent.startsWith(`版本 ${publication.getAttribute("data-version")} ·`)
        && !globalThis.document.querySelector('.publication-read-state[role="status"]')
        && !globalThis.document.querySelector('.editor-library [role="status"]')
        && controls.every(control => control && !control.disabled);
    }, id);
    await page.evaluate(() => globalThis.document.fonts.ready);
    assert.equal(await page.locator("dialog[open]").count(), 0);
  }
  async function visiblePublic(page, story, expectedTitle, assetId, privateTexts = []) {
    for (const route of [`/api/stories/${story.id}`, `/api/stories/by-slug/${story.slug}`]) {
      if (!expectedTitle) allowed.add(route);
      const response = await api(page, route, { anonymous: true });
      assert.equal(response.status, expectedTitle ? 200 : 404); assert.match(response.cache ?? "", /no-store/);
      if (expectedTitle) assert.equal(response.data.story.title, expectedTitle);
      for (const marker of privateTexts) assert.ok(!response.text.includes(marker));
    }
    const catalog = await api(page, "/api/stories", { anonymous: true });
    assert.equal(catalog.data.stories.some(item => item.id === story.id), Boolean(expectedTitle));
    for (const headers of [{}, { rsc: "1" }, { "user-agent": "Twitterbot/1.0" }]) {
      const response = await api(page, `/stories/${story.slug}`, { anonymous: true, headers });
      assert.equal(response.status, 200); assert.match(response.cache ?? "", /no-store/);
      if (!headers.rsc) assert.ok(response.text.includes(`<title>${expectedTitle ?? "故事暂不可用"} · MQ · Our Stories</title>`));
      for (const marker of privateTexts) assert.ok(!response.text.includes(marker));
    }
    for (const asset of assets) for (const method of ["GET", "HEAD"]) {
      const url = `/api/stories/${story.id}/media/${asset.id}`; allowed.add(url);
      const response = await api(page, url, { anonymous: true, method,
        headers: { "if-none-match": '"synthetic"', "if-modified-since": "Wed, 01 Jan 2031 00:00:00 GMT" } });
      assert.equal(response.status, expectedTitle && asset.id === assetId ? 200 : 404); assert.match(response.cache ?? "", /no-store/);
      if (method === "HEAD") assert.equal(response.text, "");
    }
  }
  try {
    await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
    const guest = await makePage("guest", { width: 1536, height: 1024 });
    allowed.add("/api/admin/stories"); allowed.add("/api/admin/star-slots");
    await check("guest and ordinary sessions cannot obtain publishing controls or protected slot data", async () => {
      await guest.goto(`${baseURL}/admin/stories`); assert.equal(await panel(guest).count(), 0);
      assert.equal((await api(guest, "/api/admin/star-slots")).status, 401);
      await login(guest, regular); await guest.goto(`${baseURL}/admin/stories`);
      assert.equal(await panel(guest).count(), 0); assert.equal((await api(guest, "/api/admin/star-slots")).status, 403);
    });
    const page = await makePage("desktop", { width: 1536, height: 1024 });
    await login(page, admin); await editor(page);
    let id, story;
    const initial = "合成手稿 · 星光落在纸上", nextTitle = "合成手稿 · 明确发布的第二版";
    await check("new unsaved STAR requires manual save before slot reservation or publication", async () => {
      await button(page, "新建故事").click(); await title(page).fill(initial);
      await page.getByLabel("段落内容", { exact: true }).first().fill("合成图文，仅用于发布管理界面的真实验收。");
      await panel(page).waitFor(); assert.equal(await button(page, "发布故事").isDisabled(), true);
      assert.match(await panel(page).innerText(), /保存/); assert.equal(writes.length, 0);
      await button(page, "上传或选择图片").click();
      const picker = page.getByRole("dialog", { name: "选择故事图片", exact: true });
      await picker.getByRole("button", { name: `选择图片 ${assets[0].id}`, exact: true }).click();
      await button(picker, "插入图片").click();
      await page.getByLabel("图片说明（供无障碍阅读）", { exact: true }).fill("合成蓝色图片");
      await page.getByLabel("图片题注", { exact: true }).fill("合成素材 · 非私人照片");
      id = await save(page); story = await current(id); assert.equal(story.state, "DRAFT");
      assert.equal(story.slot_id, null); await visiblePublic(page, story, null, null, [initial]);
    });
    await check("a real slot race returns 409, retains the manuscript and refreshes occupied state", async () => {
      await button(page, "刷新星位").click(); await page.getByRole("radio", { name: "星位 3", exact: true }).check();
      const competitor = await api(page, "/api/admin/stories", { method: "POST", data: { kind: "STAR", title: "合成并发星位候选",
        content: { version: 1, blocks: [{ type: "paragraph", text: "仅用于隔离星位竞争。" }] } } });
      assert.equal(competitor.status, 201);
      const rival = competitor.data.story;
      assert.equal((await api(page, path(rival.id, "slot"), { method: "PUT", data: { expectedVersion: rival.version, slotId: "star-3" } })).status, 200);
      allowed.add(path(id, "slot"));
      const response = page.waitForResponse(response => pathOf(response.url()) === path(id, "slot"));
      await button(page, "确认星位").click(); assert.equal((await response).status(), 409); await status(page, "conflict");
      assert.equal(await title(page).inputValue(), initial); assert.equal((await current(id)).slot_id, null);
      await reconcile(page); await button(page, "刷新星位").click();
      await page.waitForFunction(() => globalThis.document.querySelector('input[aria-label="星位 3"]')?.disabled);
      assert.match(await panel(page).innerText(), /草稿预留/);
      assert.equal(await button(page, "确认星位").isDisabled(), true);
      const occupied = await current(rival.id);
      assert.equal((await api(page, path(rival.id, "slot"), { method: "PUT", data: { expectedVersion: occupied.version, slotId: null } })).status, 200);
      await button(page, "刷新星位").click();
      await page.waitForFunction(() => !globalThis.document.querySelector('input[aria-label="星位 3"]')?.disabled);
      await page.getByRole("radio", { name: "星位 3", exact: true }).check(); await mutate(page, id, "slot", "确认星位");
      assert.equal((await current(id)).slot_id, "star-3");
    });
    await check("first publish and explicit update change public metadata and media only after their own UI actions", async () => {
      await mutate(page, id, "publish", "发布故事"); await visiblePublic(page, story, initial, assets[0].id);
      await title(page).fill(nextTitle); assert.equal(await button(page, "发布更新").isDisabled(), true);
      await save(page); await visiblePublic(page, story, initial, assets[0].id, [nextTitle]);
      await mutate(page, id, "publish", "发布更新"); await visiblePublic(page, story, nextTitle, assets[0].id);
    });
    await check("a second real save causes publication CAS conflict without discarding local editing", async () => {
      const local = "合成手稿 · 本窗口保留", remote = "合成手稿 · 另一窗口保存";
      await title(page).fill(local); await save(page);
      const detail = await api(page, path(id, "draft"));
      assert.equal((await api(page, path(id, "draft"), { method: "PUT", data: { expectedVersion: detail.data.story.version,
        title: remote, content: detail.data.draft.content } })).status, 200);
      allowed.add(path(id, "publish")); const before = await current(id);
      const response = page.waitForResponse(response => pathOf(response.url()) === path(id, "publish"));
      await button(page, "发布更新").click(); assert.equal((await response).status(), 409); await status(page, "conflict");
      assert.equal(await title(page).inputValue(), local); assert.deepEqual(await current(id), before);
      await visiblePublic(page, story, nextTitle, assets[0].id, [local, remote]);
      await reconcile(page); await status(page, "dirty"); assert.equal(await title(page).inputValue(), local);
      await save(page); await mutate(page, id, "publish", "发布更新");
    });
    await check("a committed publish with a lost response is reconciled once and newer input stays dirty", async () => {
      const sent = "合成手稿 · 发布响应丢失", newer = "合成手稿 · 等待时继续写";
      await title(page).fill(sent); await save(page); const before = await current(id);
      let release, observed; const gate = new Promise(done => { release = done; }); const committed = new Promise(done => { observed = done; });
      let attempts = 0;
      const handler = async route => {
        if (route.request().method() !== "POST") return route.continue();
        attempts++; const response = await route.fetch(); observed(response.status()); await gate; await route.abort("connectionfailed");
      };
      await page.route(`${baseURL}${path(id, "publish")}`, handler);
      try {
        await button(page, "发布更新").click(); assert.equal(await committed, 200);
        assert.equal(await button(page, "保存草稿").isDisabled(), true);
        await title(page).fill(newer); release(); await status(page, "uncertain");
      } finally { release(); await page.unroute(`${baseURL}${path(id, "publish")}`, handler); }
      assert.equal(attempts, 1); assert.equal((await current(id)).version, before.version + 1);
      assert.equal(await title(page).inputValue(), newer); await visiblePublic(page, story, sent, assets[0].id, [newer]);
      await reconcile(page); await status(page, "dirty");
      assert.equal(await title(page).inputValue(), newer); assert.equal(await button(page, "发布更新").isDisabled(), true);
      await save(page); await mutate(page, id, "publish", "发布更新");
    });
    await check("network failure before delivery does not retry publication or erase local content", async () => {
      const headline = "合成手稿 · 网络中断后保留";
      await title(page).fill(headline); await save(page); const before = await current(id); let attempts = 0;
      const handler = route => { attempts++; return route.abort("connectionfailed"); };
      await page.route(`${baseURL}${path(id, "publish")}`, handler);
      try { await button(page, "发布更新").click(); await status(page, "uncertain"); }
      finally { await page.unroute(`${baseURL}${path(id, "publish")}`, handler); }
      assert.equal(attempts, 1); assert.deepEqual(await current(id), before); assert.equal(await title(page).inputValue(), headline);
      await reconcile(page); await mutate(page, id, "publish", "发布更新");
    });
    await check("withdraw requires confirmation and restore reopens the earlier public revision, retaining its slot", async () => {
      const privateTitle = "合成私稿 · 下架期间未发布";
      const before = await current(id), publishedTitle = await title(page).inputValue();
      const count = writes.length;
      await button(page, "下架故事").click();
      const dialog = page.getByRole("dialog", { name: /下架/ }); await dialog.waitFor();
      await button(dialog, "取消").click(); assert.equal(writes.length, count); assert.deepEqual(await current(id), before);
      await button(page, "下架故事").click(); await mutate(page, id, "withdraw", "确认下架");
      assert.equal((await current(id)).slot_id, "star-3"); await visiblePublic(page, story, null, null, [publishedTitle]);
      await title(page).fill(privateTitle); await save(page);
      for (const choice of await panel(page).getByRole("radio").all()) assert.equal(await choice.isDisabled(), true);
      await mutate(page, id, "restore", "恢复原公开版本");
      const after = await current(id); assert.equal(after.published_revision_id, before.published_revision_id); assert.equal(after.slot_id, before.slot_id);
      assert.equal(await title(page).inputValue(), privateTitle); await visiblePublic(page, story, publishedTitle, assets[0].id, [privateTitle]);
      assert.equal(await button(page, "发布更新").isEnabled(), true);
    });
    await check("real missing media gives a recoverable 503 without publication or draft loss", async () => {
      const before = await current(id), headline = await title(page).inputValue();
      const row = (await owner.query("SELECT storage_key FROM media_asset WHERE id=$1", [assets[0].id])).rows[0];
      const file = join(storageRoot, row.storage_key, "display.webp"), held = `${file}.${randomUUID()}.held`;
      await rename(file, held);
      try {
        const response = page.waitForResponse(response => pathOf(response.url()) === path(id, "publish"));
        await button(page, "发布更新").click(); assert.equal((await response).status(), 503); await status(page, "uncertain");
        assert.equal(await title(page).inputValue(), headline); assert.deepEqual(await current(id), before);
      } finally { await rename(held, file); }
      await reconcile(page);
      await title(page).fill("合成故事 · 发布管理验收"); await save(page); await mutate(page, id, "publish", "发布更新");
    });
    await check("desktop and touch narrow layouts expose the same publishing controls without visual or overflow regressions", async () => {
      await settledEditor(page, id);
      await page.evaluate(() => globalThis.scrollTo({ top: 0, behavior: "instant" }));
      await screenshot(page, "desktop-publishing-editor");
      for (const [name, viewport, extra] of [["mobile-390", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }],
        ["mobile-320-reduced", { width: 320, height: 568 }, { isMobile: true, hasTouch: true, reducedMotion: "reduce" }]]) {
        const mobile = await makePage(name, viewport, extra); await login(mobile, admin); await editor(mobile, id);
        await publication(mobile, id, "PUBLISHED");
        await settledEditor(mobile, id);
        assert.ok(await mobile.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        if (extra.reducedMotion) assert.ok(await mobile.evaluate(() => globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches));
        await mobile.evaluate(() => globalThis.scrollTo({ top: 0, behavior: "instant" }));
        await screenshot(mobile, `${name}-publishing-editor`);
        await panel(mobile).locator(".publication-actions").evaluate(element => element.scrollIntoView({ block: "end", behavior: "instant" }));
        await screenshot(mobile, `${name}-publishing-actions`);
        await button(mobile, "下架故事").click(); await mutate(mobile, id, "withdraw", "确认下架");
        await mutate(mobile, id, "restore", "恢复原公开版本");
        await mobile.goto(`${baseURL}/stories/${story.slug}`);
        const reader = mobile.locator('dialog[data-mode="public"][data-phase="reading"]'); await reader.waitFor();
        await reader.locator(".letter-prose img").first().evaluate(image => image.decode());
        await screenshot(mobile, `${name}-published-reader`);
        assert.equal(await mobile.locator(".account-controls").isVisible(), false);
      }
      await editor(page, id); await publication(page, id, "PUBLISHED");
    });
    await check("CAMPFIRE uses no slot selector and keeps its unique public identity", async () => {
      const row = (await owner.query("SELECT id,slot_id FROM story WHERE kind='CAMPFIRE'")).rows[0];
      assert.ok(row); await editor(page, row.id); await panel(page).waitFor();
      assert.equal(await panel(page).getByRole("radio").count(), 0); assert.equal(row.slot_id, null);
      await button(page, "下架故事").click(); await mutate(page, row.id, "withdraw", "确认下架");
      await mutate(page, row.id, "restore", "恢复原公开版本");
      assert.equal((await current(row.id)).slot_id, null);
    });
    await check("revoked administrator receives a real denial and retains the locally edited manuscript", async () => {
      await editor(page, id); await title(page).fill("合成手稿 · 撤权后保留"); await save(page);
      // Wait for the save's real list/slot refresh before revoking. Otherwise a
      // pending GET may legitimately disable the UI before its write is clicked.
      await page.waitForFunction(() => ["刷新草稿列表", "刷新星位", "发布更新"].every(name => {
        const control = [...globalThis.document.querySelectorAll("button")].find(item => item.textContent.trim() === name);
        return control && !control.disabled;
      }));
      const before = await current(id), headline = await title(page).inputValue();
      const grant = (await owner.query('SELECT "userId",version FROM "AdminGrant" WHERE id=1')).rows[0];
      await revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      if (await button(page, "发布更新").isEnabled()) {
        const response = page.waitForResponse(response => pathOf(response.url()) === path(id, "publish"));
        await button(page, "发布更新").click(); assert.ok([401, 403].includes((await response).status()));
      } else {
        // A background authority check can win the race; verify the actual HTTP
        // boundary without forcing a disabled control or fabricating success.
        const response = await api(page, path(id, "publish"), { method: "POST", data: { expectedVersion: before.version } });
        assert.ok([401, 403].includes(response.status));
      }
      await status(page, "blocked");
      assert.equal(await title(page).inputValue(), headline); assert.deepEqual(await current(id), before);
      assert.equal(await button(page, "发布更新").isDisabled(), true);
    });
    assert.deepEqual(report.errors, []); report.passed = true;
  } catch (error) {
    if (activePage) await screenshot(activePage, "publishing-editor-failure").catch(() => {});
    const location = /editor-browser-tests\.mjs:(\d+):(\d+)/.exec(error?.stack ?? "");
    const safe = new Error("PUBLISHING_EDITOR_BROWSER_FAILED");
    safe.publishingStage = `editor: ${stage}${location ? ` [line ${location[1]}:${location[2]}]` : ""}`;
    if (typeof error?.actual === "number" && typeof error?.expected === "number") safe.publishingStage += ` [numeric actual=${error.actual}, expected=${error.expected}]`;
    safe.code = error?.code === "ERR_ASSERTION" ? "ERR_ASSERTION" : error?.name === "TimeoutError" ? "TIMEOUT" : "ERROR";
    throw safe;
  } finally {
    await Promise.allSettled(contexts.map(context => context.close())); await browser.close();
    await Promise.allSettled([owner.end(), maintenance.$disconnect()]);
    if (evidenceDirectory) await writeFile(resolve(evidenceDirectory, "publishing-editor-report.json"), JSON.stringify(report, null, 2));
  }
  return { passed: report.checks.length, total: 12, screenshots: report.screenshots.length };
}
