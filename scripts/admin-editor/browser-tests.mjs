import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import { chromium } from "playwright";

async function installFetchAudit(context, report, secrets, privateCanaries = []) {
  report.fetchAudit ??= { inspected: 0, paths: {} };
  await context.exposeBinding("__mqEditorFetchAudit", (_source, result) => {
    // Only path/status/violation metadata crosses this binding; never a body,
    // password, Cookie, session token or internal account field.
    const path = typeof result?.path === "string" && result.path.startsWith("/api/") ? result.path : "invalid-path";
    const status = Number.isInteger(result?.status) ? result.status : 0;
    if (result?.kind === "read-failed") report.errors.push({ kind: "uninspected-api-body", path, status });
    else if (result?.kind === "inspected") {
      report.fetchAudit.inspected++;
      report.fetchAudit.paths[path] = (report.fetchAudit.paths[path] ?? 0) + 1;
      if (result.internalField) report.privacyViolations.push({ path, kind: "internal-field" });
      if (result.privateContent) report.privacyViolations.push({ path, kind: "private-content" });
    } else report.errors.push({ kind: "invalid-fetch-audit-result", path, status });
  });
  await context.addInitScript(({ secrets, privateCanaries }) => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const address = new globalThis.URL(response.url, globalThis.location.href);
      if (address.origin !== globalThis.location.origin || !address.pathname.startsWith("/api/")) return response;
      let result;
      try {
        // The application gets its untouched Response only after the clone is
        // inspected. A subsequent UI navigation cannot invalidate CDP body IDs.
        const text = await response.clone().text();
        result = { kind: "inspected", path: address.pathname, status: response.status,
          internalField: /@accounts\.invalid|"(?:token|email|emailVerified|password)"\s*:/.test(text)
            || secrets.some(value => text.includes(value)),
          privateContent: !address.pathname.startsWith("/api/admin/stories") && privateCanaries.some(value => text.includes(value)) };
      } catch {
        result = { kind: "read-failed", path: address.pathname, status: response.status };
      }
      await globalThis.__mqEditorFetchAudit(result);
      return response;
    };
  }, { secrets, privateCanaries });
}

// The parent admin-drafts runner owns all temporary databases, roles, synthetic
// credentials and TLS processes. This suite never creates production identities,
// changes authorization, saves Cookie/HAR/storageState, or prints private bodies.
export async function runBrowser({ baseURL, evidenceDirectory, admin, regular,
  publicStory, privateCanaries = [], ignoreHTTPSErrors = true, expectedSecure = true } = {}) {
  const origin = new URL(baseURL);
  assert.equal(origin.hostname, "127.0.0.1");
  assert.equal(origin.protocol, "https:");
  assert.equal(expectedSecure, true);
  assert.ok(admin?.password && regular?.password && evidenceDirectory);
  assert.match(publicStory?.id ?? "", /^[a-f0-9-]{36}$/i);
  assert.ok(publicStory.slug && publicStory.title);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MQ_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.MQ_PLAYWRIGHT_EXECUTABLE } : {}) });
  await mkdir(evidenceDirectory, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), browser: browser.version(),
    browserPath: "Browser plugin not available; locked Playwright Chromium",
    scope: "P2-08B editor and return to an isolated published story; no private feather-letter preview",
    origin: origin.origin, checks: [], screenshots: [], errors: [], privacyViolations: [], expectedFailures: [], passed: false };
  const contexts = [], allowedFailures = new Set(), allowedNetworkPaths = new Set();
  const secrets = [admin.password, regular.password];
  const canaries = [...privateCanaries];
  let stage = "initialization", activePage, finalized = false;
  const fingerprint = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
  const pathOf = value => { try { return new URL(value).pathname; } catch { return "unknown"; } };
  const allow = (path, ...statuses) => statuses.forEach(status => allowedFailures.add(`${path}:${status}`));
  const workspace = page => page.getByTestId("story-editor");
  const title = page => page.getByLabel("故事标题", { exact: true });
  const paragraphs = page => page.getByLabel("段落内容", { exact: true });
  const paragraphValues = page => paragraphs(page).evaluateAll(elements => elements.map(element => element.value));
  const blocks = page => page.getByTestId("content-block");
  const button = (page, name) => page.getByRole("button", { name, exact: true });
  const save = page => button(page, "保存草稿");
  const storyPath = id => `/api/admin/stories/${id}/draft`;

  async function finalizeBrowserAudit() {
    if (finalized) return;
    finalized = true;
    const closures = await Promise.allSettled(contexts.map(instance => instance.close()));
    if (closures.some(result => result.status === "rejected")) report.errors.push({ kind: "context-close-failed" });
    await browser.close();
  }

  async function check(name, action) {
    stage = name;
    await action();
    report.checks.push({ name, passed: true });
    console.log(`PASS editor browser: ${name}`);
  }
  async function shot(page, name) {
    const file = `${name}.png`;
    await page.screenshot({ path: resolve(evidenceDirectory, file), fullPage: false, scale: "css",
      mask: await page.locator('input[type="password"]').all(), maskColor: "#132334" });
    report.screenshots.push(file);
  }
  function observe(page, variant) {
    page.on("pageerror", error => report.errors.push({ variant, kind: "runtime", fingerprint: fingerprint(error.message) }));
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      const path = pathOf(message.location().url);
      const status = /status of (\d{3})/.exec(message.text())?.[1];
      if ((status && allowedFailures.has(`${path}:${status}`))
        || (allowedNetworkPaths.has(path) && /net::ERR_|Failed to fetch|NetworkError/.test(message.text()))) {
        report.expectedFailures.push({ variant, kind: "console", path, ...(status ? { status: Number(status) } : {}) });
      } else report.errors.push({ variant, kind: message.type(), fingerprint: fingerprint(message.text()) });
    });
    page.on("response", response => {
      const path = pathOf(response.url()), status = response.status();
      if (status >= 400) {
        const target = allowedFailures.has(`${path}:${status}`) ? report.expectedFailures : report.errors;
        target.push({ variant, kind: "http", path, status });
      }
    });
  }
  async function context(name, viewport, extra = {}) {
    const instance = await browser.newContext({ viewport, ignoreHTTPSErrors, ...extra }); contexts.push(instance);
    await installFetchAudit(instance, report, secrets, canaries);
    const page = await instance.newPage(); page.setDefaultTimeout(15_000); activePage = page; observe(page, name);
    return { context: instance, page };
  }
  async function home(page) {
    const response = await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200);
    await page.locator(".account-controls button").first().waitFor();
    await page.waitForFunction(() => !globalThis.document.querySelector(".account-controls button")?.disabled);
  }
  async function login(page, account) {
    await home(page);
    await page.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
    const dialog = page.locator(".auth-dialog");
    await dialog.getByLabel("用户名", { exact: true }).fill(account.username);
    await dialog.getByLabel("密码", { exact: true }).fill(account.password);
    await dialog.locator(".auth-submit").click();
    await dialog.waitFor({ state: "detached" });
    await page.locator(".account-username").waitFor();
  }
  async function api(page, path, { method = "GET", body, headers = {} } = {}) {
    const result = await page.evaluate(async ({ path, method, body, headers }) => {
      const response = await globalThis.fetch(path, { method, credentials: "same-origin", cache: "no-store",
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text(); let data = null;
      try { data = JSON.parse(text); } catch { /* document/RSC probes are not JSON */ }
      return { status: response.status, text, data, cache: response.headers.get("cache-control") };
    }, { path, method, body, headers });
    // Explicit complete HTTP/HTML/RSC probes do not depend on passive CDP body
    // handles. Bodies stay in memory and are never written to test artifacts.
    assert.ok(!/@accounts\.invalid|"(?:token|email|emailVerified|password)"\s*:/.test(result.text));
    assert.ok(secrets.every(secret => !result.text.includes(secret)));
    return result;
  }
  async function openEditor(page, id) {
    activePage = page;
    const response = await page.goto(`${baseURL}/admin/stories${id ? `?story=${id}` : ""}`, { waitUntil: "domcontentloaded" });
    assert.equal(response.status(), 200);
    await workspace(page).waitFor();
    assert.match(await page.title(), /MQ/);
    assert.equal(await page.locator("nextjs-portal").count(), 0);
    if (id) await title(page).waitFor();
  }
  async function state(page, ...values) {
    await page.waitForFunction(values => values.includes(globalThis.document.querySelector('[data-testid="editor-status"]')?.getAttribute("data-state")), values);
  }
  async function saved(page) {
    await state(page, "saved");
    const id = new URL(page.url()).searchParams.get("story");
    assert.match(id ?? "", /^[a-f0-9-]{36}$/i); return id;
  }
  async function readDraft(page, id) {
    const response = await api(page, storyPath(id)); assert.equal(response.status, 200);
    assert.match(response.cache ?? "", /private.*no-store/); return response.data;
  }
  async function fresh(page, headline, bodyText = "这是一段合成内容，仅用于编辑器自动化验收。") {
    await button(page, "新建故事").click();
    await title(page).fill(headline); await paragraphs(page).first().fill(bodyText);
  }
  async function reconcile(page, choice = "保留本地并继续编辑") {
    await button(page, "读取服务器版本").click();
    await button(page, choice).waitFor(); await button(page, choice).click();
  }
  async function fixedFailure(page, path, status, code, action) {
    allow(path, status);
    const handler = route => route.request().method() === "PUT"
      ? route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ code }),
        headers: { "cache-control": "private, no-store" } }) : route.continue();
    await page.route(`${baseURL}${path}`, handler);
    try { await action(); } finally { await page.unroute(`${baseURL}${path}`, handler); }
  }

  try {
    const guest = await context("guest", { width: 1536, height: 1024 });
    allow("/api/admin/stories", 401, 403);
    await check("guest and ordinary users cannot receive private editor content", async () => {
      await guest.page.goto(`${baseURL}/admin/stories`, { waitUntil: "domcontentloaded" });
      assert.equal(await workspace(guest.page).count(), 0);
      assert.equal(await title(guest.page).count(), 0);
      assert.equal((await api(guest.page, "/api/admin/stories")).status, 401);
      await shot(guest.page, "desktop-guest-denied");
      await login(guest.page, regular);
      await guest.page.goto(`${baseURL}/admin/stories`, { waitUntil: "domcontentloaded" });
      assert.equal(await workspace(guest.page).count(), 0);
      assert.equal(await title(guest.page).count(), 0);
      assert.equal((await api(guest.page, "/api/admin/stories")).status, 403);
      const rsc = await api(guest.page, "/admin/stories?_rsc=private-check", { headers: { RSC: "1" } });
      for (const value of canaries) assert.ok(!rsc.text.includes(value));
      await shot(guest.page, "desktop-ordinary-denied");
    });
    const desktop = await context("desktop", { width: 1536, height: 1024 });
    const page = desktop.page;
    await login(page, admin);
    await openEditor(page);
    await check("administrator entry uses a real Secure HttpOnly session and no draft RSC payload", async () => {
      const cookies = (await desktop.context.cookies()).filter(cookie => cookie.name.includes("session_token"));
      assert.equal(cookies.length, 1); assert.equal(cookies[0].secure, true); assert.equal(cookies[0].httpOnly, true);
      assert.equal(cookies[0].sameSite, "Lax");
      const rsc = await api(page, "/admin/stories?_rsc=private-check", { headers: { RSC: "1" } });
      for (const value of canaries) assert.ok(!rsc.text.includes(value));
      assert.match(rsc.cache ?? "", /no-store/);
      assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
    });

    let id;
    const initialTitle = "合成故事：山坡上的晚风";
    const paragraphA = "合成段落一。远处的灯火亮起，我们把这一刻留在纸上。";
    const paragraphB = "合成段落二。这里只验证编辑行为，不记录真实回忆。";
    await check("UI creates a STAR draft with paragraphs, ordering, styles and existing synthetic image", async () => {
      await fresh(page, initialTitle, paragraphA);
      await button(page, "添加段落").click(); await paragraphs(page).nth(1).fill(paragraphB);
      await blocks(page).nth(0).getByLabel("段落样式", { exact: true }).selectOption("emphasis");
      await blocks(page).nth(1).getByLabel("段落样式", { exact: true }).selectOption("strong");
      await blocks(page).nth(1).getByRole("button", { name: "上移", exact: true }).click();
      assert.equal(await paragraphs(page).first().inputValue(), paragraphB);
      await blocks(page).nth(0).getByRole("button", { name: "下移", exact: true }).click();
      await button(page, "添加段落").click(); await paragraphs(page).nth(2).fill("合成待删除段落");
      await blocks(page).nth(2).getByRole("button", { name: "删除", exact: true }).click();
      assert.equal(await paragraphs(page).count(), 2);
      await button(page, "添加图片").click();
      await page.getByLabel("图片说明（供无障碍阅读）", { exact: true }).fill("合成星空配图");
      await page.getByLabel("图片题注", { exact: true }).fill("合成素材 · 复用已验收 MQ 星空");
      await save(page).click(); id = await saved(page);
      const detail = await readDraft(page, id);
      assert.equal(detail.draft.title, initialTitle);
      assert.deepEqual(detail.draft.content.blocks.slice(0, 2), [
        { type: "paragraph", text: paragraphA, style: "emphasis" }, { type: "paragraph", text: paragraphB, style: "strong" },
      ]);
      assert.equal(detail.draft.content.blocks[2].src, "/scene/night-sky.webp");
      assert.equal(detail.draft.content.blocks[2].alt, "合成星空配图");
      assert.equal(detail.story.state, "DRAFT"); assert.match(detail.story.slug, /^story-[a-f0-9]{32}$/);
      const storage = await page.evaluate(() => ({
        local: Object.values(globalThis.localStorage), session: Object.values(globalThis.sessionStorage),
      }));
      for (const value of [...storage.local, ...storage.session]) {
        assert.ok(![initialTitle, paragraphA, paragraphB, ...canaries].some(text => value.includes(text)));
      }
      await page.evaluate(() => globalThis.scrollTo({ top: 0, behavior: "instant" })); await shot(page, "desktop-editor-top");
      await title(page).evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
      await shot(page, "desktop-editor-saved");
    });

    await check("new private draft stays out of public HTML, RSC, metadata and denied detail responses", async () => {
      canaries.push(initialTitle, paragraphA, paragraphB);
      for (const path of ["/", "/m", "/q", "/admin/stories"]) {
        for (const headers of [{}, { RSC: "1" }]) {
          const result = await api(page, path, { headers }); assert.equal(result.status, 200);
          for (const value of canaries) assert.ok(!result.text.includes(value));
        }
      }
      allow(storyPath(id), 403);
      const denied = await api(guest.page, storyPath(id)); assert.equal(denied.status, 403);
      for (const value of canaries) assert.ok(!denied.text.includes(value));
    });

    await check("editing during a real committed save does not acknowledge newer unsent input", async () => {
      const snapshot = `${initialTitle} · 发送快照`, newer = `${initialTitle} · 继续编辑`;
      await title(page).fill(snapshot);
      let release; const gate = new Promise(resolve => { release = resolve; });
      let observed; const committed = new Promise(resolve => { observed = resolve; });
      const handler = async route => {
        if (route.request().method() !== "PUT") return route.continue();
        const response = await route.fetch(); assert.equal(response.status(), 200); observed(); await gate;
        await route.fulfill({ response });
      };
      await page.route(`${baseURL}${storyPath(id)}`, handler);
      try {
        await save(page).click(); await committed; await state(page, "saving");
        await title(page).fill(newer); release(); await state(page, "dirty");
        assert.equal(await title(page).inputValue(), newer);
        assert.equal((await readDraft(page, id)).draft.title, snapshot);
      } finally { release(); await page.unroute(`${baseURL}${storyPath(id)}`, handler); }
      await shot(page, "desktop-unsaved-after-save");
      await save(page).click(); await saved(page);
      assert.equal((await readDraft(page, id)).draft.title, newer);
    });

    await check("a delayed different-draft GET cannot discard edits made after navigation began", async () => {
      const original = await readDraft(page, id);
      const candidateTitle = "合成候选稿 · 延迟读取";
      const candidate = await api(page, "/api/admin/stories", { method: "POST", body: { kind: "STAR", title: candidateTitle,
        content: { version: 1, blocks: [{ type: "paragraph", text: "合成候选内容，与当前手稿不同。" }] } } });
      assert.equal(candidate.status, 201);
      const candidateId = candidate.data.story.id;
      await button(page, "刷新草稿列表").click();
      const row = page.getByTestId("draft-row").filter({ hasText: candidateTitle }); await row.waitFor();
      let release; const gate = new Promise(resolve => { release = resolve; });
      let observed; const received = new Promise(resolve => { observed = resolve; });
      let writes = 0;
      const count = request => { if (pathOf(request.url()).startsWith("/api/admin/stories") && ["POST", "PUT"].includes(request.method())) writes++; };
      const handler = async route => {
        const response = await route.fetch(); observed(response.status()); await gate;
        await route.fulfill({ response });
      };
      page.on("request", count);
      await page.route(`${baseURL}${storyPath(candidateId)}`, handler);
      const newer = "合成当前稿 · 读取别稿期间继续输入";
      try {
        await row.getByRole("button").click(); assert.equal(await received, 200);
        await title(page).fill(newer);
        assert.equal(await save(page).isDisabled(), true);
        release();
        await page.getByText("读取期间本地内容已变化，已取消切换。你的编辑仍然保留。", { exact: true }).waitFor();
        await state(page, "dirty");
        assert.equal(new URL(page.url()).searchParams.get("story"), id);
        assert.equal(await title(page).inputValue(), newer);
        assert.deepEqual(await paragraphValues(page), original.draft.content.blocks.filter(block => block.type === "paragraph").map(block => block.text));
        assert.equal(writes, 0);
      } finally { release(); page.off("request", count); await page.unroute(`${baseURL}${storyPath(candidateId)}`, handler); }
      assert.equal((await readDraft(page, id)).draft.title, original.draft.title);
      assert.equal((await readDraft(page, candidateId)).draft.title, candidateTitle);
      await save(page).click(); await saved(page);
      assert.equal((await readDraft(page, id)).draft.title, newer);
      assert.equal((await readDraft(page, candidateId)).draft.title, candidateTitle);
    });

    await check("400 validation failure retains every local field and remains manually recoverable", async () => {
      await title(page).fill("合成标题 · 验证失败仍保留");
      const before = await paragraphValues(page);
      await fixedFailure(page, storyPath(id), 400, "DRAFT_VALIDATION", async () => {
        await save(page).click(); await state(page, "error");
        assert.equal(await title(page).inputValue(), "合成标题 · 验证失败仍保留");
        assert.deepEqual(await paragraphValues(page), before);
      });
      await save(page).click(); await saved(page);
    });

    await check("list loading failure is visible and manual retry preserves the active local editor", async () => {
      const headline = "合成稿 · 列表读取失败仍保留";
      await title(page).fill(headline);
      allow("/api/admin/stories", 503);
      const pattern = `${baseURL}/api/admin/stories?*`;
      const handler = route => route.request().method() === "GET"
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "ADMIN_UNAVAILABLE" }),
          headers: { "cache-control": "private, no-store" } }) : route.continue();
      await page.route(pattern, handler);
      try {
        await button(page, "刷新草稿列表").click();
        await page.getByText("暂时无法读取或处理请求，请稍后重试。你的本地编辑仍然保留。", { exact: true }).waitFor();
        assert.equal(await title(page).inputValue(), headline);
        await state(page, "dirty");
      } finally { await page.unroute(pattern, handler); }
      const reloaded = page.waitForResponse(response => pathOf(response.url()) === "/api/admin/stories"
        && response.request().method() === "GET" && response.status() === 200);
      await button(page, "刷新草稿列表").click(); await reloaded;
      assert.equal(await title(page).inputValue(), headline);
      await save(page).click(); await saved(page);
    });

    await check("503 response becomes uncertain without repeating PUT and preserves local content", async () => {
      const before = await readDraft(page, id);
      await title(page).fill("合成标题 · 服务错误仍保留");
      let attempts = 0;
      const count = request => { if (pathOf(request.url()) === storyPath(id) && request.method() === "PUT") attempts++; };
      page.on("request", count);
      try {
        await fixedFailure(page, storyPath(id), 503, "ADMIN_UNAVAILABLE", async () => {
          await save(page).click(); await state(page, "uncertain");
          assert.equal(await save(page).isDisabled(), true);
          assert.equal(await title(page).inputValue(), "合成标题 · 服务错误仍保留");
          await shot(page, "desktop-uncertain-result");
        });
        assert.equal(attempts, 1); assert.equal((await readDraft(page, id)).story.version, before.story.version);
      } finally { page.off("request", count); }
      await reconcile(page); await state(page, "dirty");
      await save(page).click(); await saved(page);
    });

    await check("lost response after a real PUT commit is reconciled without a duplicate update", async () => {
      const before = await readDraft(page, id);
      await title(page).fill("合成标题 · 已提交但响应丢失");
      allowedNetworkPaths.add(storyPath(id)); let attempts = 0;
      const handler = async route => {
        if (route.request().method() !== "PUT") return route.continue();
        attempts++; const response = await route.fetch(); assert.equal(response.status(), 200);
        await route.abort("connectionfailed");
      };
      await page.route(`${baseURL}${storyPath(id)}`, handler);
      try { await save(page).click(); await state(page, "uncertain"); assert.equal(await save(page).isDisabled(), true); }
      finally { await page.unroute(`${baseURL}${storyPath(id)}`, handler); }
      assert.equal(attempts, 1);
      assert.equal(await title(page).inputValue(), "合成标题 · 已提交但响应丢失");
      const committed = await readDraft(page, id);
      assert.equal(committed.story.version, before.story.version + 1);
      await reconcile(page); await state(page, "saved");
      assert.equal((await readDraft(page, id)).story.version, committed.story.version);
    });

    await check("a second authenticated tab causes real 409 without overwriting either local draft", async () => {
      const other = await desktop.context.newPage(); observe(other, "concurrent-tab"); other.setDefaultTimeout(15_000);
      await openEditor(other, id);
      await title(page).fill("合成稿 · 另一窗口已保存"); await save(page).click(); await saved(page);
      await title(other).fill("合成稿 · 当前窗口未保存"); allow(storyPath(id), 409);
      await save(other).click(); await state(other, "conflict");
      assert.equal(await title(other).inputValue(), "合成稿 · 当前窗口未保存");
      assert.equal((await readDraft(other, id)).draft.title, "合成稿 · 另一窗口已保存");
      await shot(other, "desktop-concurrent-conflict");
      await reconcile(other); await state(other, "dirty");
      assert.equal(await title(other).inputValue(), "合成稿 · 当前窗口未保存");
      await save(other).click(); await saved(other);
      assert.equal((await readDraft(other, id)).draft.title, "合成稿 · 当前窗口未保存");
      await other.close(); await openEditor(page, id);
    });

    await check("canceling unsaved leave restores text selection and editing context", async () => {
      const text = `${paragraphA}\n合成未保存内容，用于取消离开后的光标检查。`;
      await paragraphs(page).first().fill(text); await paragraphs(page).first().focus();
      await paragraphs(page).first().evaluate(element => element.setSelectionRange(3, 9));
      const before = await paragraphs(page).first().evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }));
      await page.getByRole("link", { name: "返回 MQ", exact: true }).click();
      const dialog = page.getByRole("dialog"); await dialog.waitFor();
      await dialog.getByRole("button", { name: "继续编辑", exact: true }).click();
      // The component restores focus/selection in the next animation frame after
      // native dialog closure. A fast Linux click may return before that frame.
      await page.waitForFunction(before => {
        const element = globalThis.document.querySelector('textarea[aria-label="段落内容"]');
        return element === globalThis.document.activeElement && element.selectionStart === before.start
          && element.selectionEnd === before.end && element.scrollTop === before.scroll;
      }, before);
      assert.equal(await paragraphs(page).first().inputValue(), text);
      assert.equal(await paragraphs(page).first().evaluate(element => element === globalThis.document.activeElement), true);
      const after = await paragraphs(page).first().evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, scroll: element.scrollTop }));
      assert.deepEqual(after, before);
    });

    await check("refresh prompts for unsaved input and reloads only server-confirmed content", async () => {
      const confirmed = await readDraft(page, id); let prompted = false;
      page.once("dialog", async dialog => { assert.equal(dialog.type(), "beforeunload"); prompted = true; await dialog.accept(); });
      await page.reload({ waitUntil: "domcontentloaded" }); await workspace(page).waitFor(); await title(page).waitFor();
      assert.equal(prompted, true); await state(page, "saved");
      assert.equal(await title(page).inputValue(), confirmed.draft.title);
      assert.equal(await paragraphs(page).first().inputValue(), confirmed.draft.content.blocks[0].text);
    });

    await check("new-story lost POST response never duplicates and is manually bound to the stored draft", async () => {
      const headline = `合成稿 · 新建响应丢失 ${randomUUID().slice(0, 8)}`;
      await fresh(page, headline); let createdId, attempts = 0;
      allowedNetworkPaths.add("/api/admin/stories");
      const handler = async route => {
        if (route.request().method() !== "POST") return route.continue();
        attempts++; const response = await route.fetch(); assert.equal(response.status(), 201);
        createdId = (await response.json()).story.id; await route.abort("connectionfailed");
      };
      await page.route(`${baseURL}/api/admin/stories`, handler);
      try { await save(page).click(); await state(page, "uncertain"); assert.equal(await save(page).isDisabled(), true); }
      finally { await page.unroute(`${baseURL}/api/admin/stories`, handler); }
      assert.equal(attempts, 1); assert.equal(await title(page).inputValue(), headline);
      await button(page, "刷新草稿列表").click();
      const row = page.getByTestId("draft-row").filter({ hasText: headline }); await row.waitFor();
      await row.getByRole("button", { name: "核对这篇草稿", exact: true }).click();
      await button(page, "保留本地并继续编辑").click(); await state(page, "saved");
      assert.equal(new URL(page.url()).searchParams.get("story"), createdId);
      const list = await api(page, "/api/admin/stories?limit=50");
      assert.equal(list.data.items.filter(story => story.draftTitle === headline).length, 1);
      id = createdId;
    });

    await check("the existing singleton CAMPFIRE returns an actionable conflict without duplicate story", async () => {
      await button(page, "新建篝火").click();
      await title(page).fill("合成篝火 · 唯一身份冲突"); await paragraphs(page).first().fill("合成篝火内容");
      allow("/api/admin/stories", 409); await save(page).click(); await state(page, "conflict");
      assert.equal(await title(page).inputValue(), "合成篝火 · 唯一身份冲突");
      assert.equal(await save(page).isDisabled(), true);
      const list = await api(page, "/api/admin/stories?limit=50");
      assert.equal(list.data.items.filter(story => story.kind === "CAMPFIRE").length, 1);
      await button(page, "新建故事").click();
      await page.getByRole("dialog").getByRole("button", { name: "放弃并离开", exact: true }).click();
    });

    await check("draft list uses bounded server pagination without duplicate rows", async () => {
      for (let index = 0; index < 23; index++) {
        const result = await api(page, "/api/admin/stories", { method: "POST", body: { kind: "STAR", title: `合成分页草稿 ${index + 1}`,
          content: { version: 1, blocks: [{ type: "paragraph", text: "合成分页夹具" }] } } }); assert.equal(result.status, 201);
      }
      await button(page, "刷新草稿列表").click(); await button(page, "更多草稿").waitFor();
      const before = await page.getByTestId("draft-row").count(); await button(page, "更多草稿").click();
      await page.waitForFunction(before => globalThis.document.querySelectorAll('[data-testid="draft-row"]').length > before, before);
      const ids = await page.getByTestId("draft-row").evaluateAll(rows => rows.map(row => row.getAttribute("data-story-id")));
      assert.equal(new Set(ids).size, ids.length);
      await shot(page, "desktop-draft-list");
    });

    await check("loss of authentication preserves local input but blocks a new write", async () => {
      await openEditor(page, id); await title(page).fill("合成稿 · 会话失效仍保留");
      assert.equal((await api(page, "/api/auth/sign-out", { method: "POST", body: {} })).status, 200);
      allow(storyPath(id), 401); await save(page).click(); await state(page, "blocked");
      assert.equal(await title(page).inputValue(), "合成稿 · 会话失效仍保留");
      assert.equal(await save(page).isDisabled(), true);
      await shot(page, "desktop-session-expired");
    });

    for (const variant of [
      { name: "mobile-390", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "no-preference" },
      { name: "mobile-320-reduced", viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" },
    ]) {
      const mobile = await context(variant.name, variant.viewport, { isMobile: variant.isMobile, hasTouch: variant.hasTouch, reducedMotion: variant.reducedMotion });
      const device = mobile.page;
      await login(device, admin); await openEditor(device);
      await check(`${variant.name}: touch editing, reorder and manual save remain operable without horizontal overflow`, async () => {
        await fresh(device, `合成故事 · ${variant.name}`, "合成短段落。小屏幕也能清楚书写。");
        await button(device, "添加段落").click(); await paragraphs(device).nth(1).fill("合成第二段，触屏调整顺序。");
        await blocks(device).nth(1).getByRole("button", { name: "上移", exact: true }).click();
        await save(device).click(); const mobileId = await saved(device);
        assert.equal((await readDraft(device, mobileId)).draft.content.blocks[0].text, "合成第二段，触屏调整顺序。");
        assert.equal(await device.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
        await device.evaluate(() => globalThis.scrollTo({ top: 0, behavior: "instant" })); await shot(device, `${variant.name}-editor-top`);
        await title(device).evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
        await shot(device, `${variant.name}-editor`);
      });
      await check(`${variant.name}: unsaved switch cancellation and return to MQ preserve the existing reader`, async () => {
        await title(device).fill(`合成未保存稿 · ${variant.name}`); await button(device, "新建故事").click();
        await device.getByRole("dialog").getByRole("button", { name: "继续编辑", exact: true }).click();
        assert.equal(await title(device).inputValue(), `合成未保存稿 · ${variant.name}`);
        await device.getByRole("link", { name: "返回 MQ", exact: true }).click();
        await device.getByRole("dialog").getByRole("button", { name: "放弃并离开", exact: true }).click();
        const publicEntry = device.locator(`.story-entry--star[data-story-id="${publicStory.id}"]`);
        await publicEntry.waitFor();
        assert.equal(await device.locator(".story-entry--star").count(), 1);
        await publicEntry.click(); await device.locator('.letter-dialog[data-phase="reading"]').waitFor();
        assert.equal(await device.locator("#letter-title").textContent(), publicStory.title);
        assert.equal(new URL(device.url()).pathname, `/stories/${publicStory.slug}`);
        assert.equal(await device.locator(".scene-nav").isVisible(), false);
        await shot(device, `${variant.name}-unchanged-letter`);
        await device.locator("#letter-comment").fill("合成留言 · 不发送");
        await device.locator(".letter-close").click();
        await device.locator(".letter-discard").getByRole("button", { name: "继续编辑", exact: true }).click();
        assert.equal(await device.locator("#letter-comment").inputValue(), "合成留言 · 不发送");
        await device.locator(".letter-close").click();
        await device.locator(".letter-discard").getByRole("button", { name: "放弃并关闭", exact: true }).click();
        await device.locator(".letter-dialog").waitFor({ state: "detached" });
      });
    }
    await finalizeBrowserAudit();
    assert.ok(report.fetchAudit.inspected > 0);
    assert.equal(report.errors.length, 0, "Unexpected browser error; details hashed");
    assert.equal(report.privacyViolations.length, 0, "Sensitive response detected; contents withheld");
    report.passed = true;
  } catch (error) {
    report.failedAt = stage;
    report.failure = {
      kind: ["AssertionError", "TimeoutError", "Error"].includes(error?.name) ? error.name : "Error",
      // A source line and numeric comparisons diagnose the failure without
      // copying Playwright call logs, input values or private response bodies.
      source: /browser-tests\.mjs:\d+:\d+/.exec(error?.stack ?? "")?.[0] ?? "unknown",
      ...(typeof error?.operator === "string" ? { operator: error.operator } : {}),
      ...(["number", "boolean"].includes(typeof error?.expected) ? { expected: error.expected } : {}),
      ...(["number", "boolean"].includes(typeof error?.actual) ? { actual: error.actual } : {}),
    };
    console.error(`Editor browser failure: ${stage}; ${JSON.stringify(report.failure)}`);
    if (activePage) await shot(activePage, "failure").catch(() => {});
    // The parent runner emits only its stage/error code, never this cause.
    throw new Error(`Editor browser failed at ${stage}; sensitive details withheld`, { cause: error });
  } finally {
    await finalizeBrowserAudit();
    await writeFile(resolve(evidenceDirectory, "editor-browser-results.json"), JSON.stringify(report, null, 2));
  }
  console.log(`Editor browser integration: ${report.checks.length} checks passed; ${report.screenshots.length} screenshots; no unexpected errors or sensitive responses`);
}

/** A second, fresh database is owned by the parent runner. It has one synthetic
 * administrator and no stories, so the singleton CAMPFIRE can be created by UI
 * without deleting or changing any preceding suite's fixtures. The parent also
 * verifies slot_id IS NULL directly; private HTTP DTOs intentionally omit it. */
export async function runFreshCampfireBrowser({ baseURL, evidenceDirectory, admin,
  ignoreHTTPSErrors = true, expectedSecure = true } = {}) {
  const origin = new URL(baseURL);
  assert.equal(origin.hostname, "127.0.0.1"); assert.equal(origin.protocol, "https:");
  assert.equal(expectedSecure, true); assert.ok(admin?.password && admin?.username && evidenceDirectory);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MQ_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.MQ_PLAYWRIGHT_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1536, height: 1024 }, ignoreHTTPSErrors });
  const page = await context.newPage(); page.setDefaultTimeout(15_000);
  await mkdir(evidenceDirectory, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), browser: browser.version(),
    scope: "Fresh isolated CAMPFIRE UI creation; parent verifies database slot invariant", checks: [],
    screenshots: [], errors: [], privacyViolations: [], expectedFailures: [], passed: false };
  const fingerprint = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
  const pathOf = value => { try { return new URL(value).pathname; } catch { return "unknown"; } };
  let stage = "fresh CAMPFIRE login", expectedConflict = false, finalized = false;
  const title = page.getByLabel("故事标题", { exact: true });
  const paragraph = page.getByLabel("段落内容", { exact: true }).first();
  const save = page.getByRole("button", { name: "保存草稿", exact: true });
  async function finalizeBrowserAudit() {
    if (finalized) return;
    finalized = true;
    await context.close(); await browser.close();
  }
  page.on("pageerror", error => report.errors.push({ kind: "runtime", fingerprint: fingerprint(error.message) }));
  page.on("console", message => {
    if (!["error", "warning"].includes(message.type())) return;
    if (expectedConflict && pathOf(message.location().url) === "/api/admin/stories" && /status of 409/.test(message.text())) {
      report.expectedFailures.push({ kind: "console", path: "/api/admin/stories", status: 409 });
    } else report.errors.push({ kind: message.type(), fingerprint: fingerprint(message.text()) });
  });
  page.on("response", response => {
    const path = pathOf(response.url()), status = response.status();
    if (status >= 400) {
      (expectedConflict && path === "/api/admin/stories" && status === 409 ? report.expectedFailures : report.errors)
        .push({ kind: "http", path, status });
    }
  });
  async function check(name, action) {
    stage = name; await action(); report.checks.push({ name, passed: true }); console.log(`PASS fresh CAMPFIRE browser: ${name}`);
  }
  async function api(path) {
    const result = await page.evaluate(async path => {
      const response = await globalThis.fetch(path, { credentials: "same-origin", cache: "no-store" });
      return { status: response.status, data: await response.json(), cache: response.headers.get("cache-control") };
    }, path);
    assert.equal(result.status, 200); assert.match(result.cache ?? "", /private.*no-store/); return result.data;
  }
  async function state(value) {
    await page.waitForFunction(value => globalThis.document.querySelector('[data-testid="editor-status"]')?.getAttribute("data-state") === value, value);
  }
  async function screenshot(name) {
    const filename = `${name}.png`;
    await page.screenshot({ path: resolve(evidenceDirectory, filename), fullPage: false, scale: "css",
      mask: await page.locator('input[type="password"]').all(), maskColor: "#132334" });
    report.screenshots.push(filename);
  }
  await installFetchAudit(context, report, [admin.password]);
  try {
    await check("synthetic administrator logs in using a real Secure HttpOnly session", async () => {
      assert.equal((await page.goto(baseURL, { waitUntil: "domcontentloaded" })).status(), 200);
      await page.waitForFunction(() => !globalThis.document.querySelector(".account-controls button")?.disabled);
      await page.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
      const dialog = page.locator(".auth-dialog");
      await dialog.getByLabel("用户名", { exact: true }).fill(admin.username);
      await dialog.getByLabel("密码", { exact: true }).fill(admin.password);
      await dialog.locator(".auth-submit").click(); await dialog.waitFor({ state: "detached" });
      const cookies = (await context.cookies()).filter(cookie => cookie.name.includes("session_token"));
      assert.equal(cookies.length, 1); assert.equal(cookies[0].secure, true); assert.equal(cookies[0].httpOnly, true);
      assert.equal(cookies[0].sameSite, "Lax");
    });
    let id;
    const headline = "合成篝火故事 · 从第一封手稿开始";
    const text = "这是一篇独立测试库中的合成篝火故事，不包含真实回忆。";
    await check("empty library creates its first CAMPFIRE via real UI and HTTP 201", async () => {
      assert.equal((await page.goto(`${baseURL}/admin/stories`, { waitUntil: "domcontentloaded" })).status(), 200);
      await page.getByTestId("story-editor").waitFor();
      assert.equal((await api("/api/admin/stories?limit=50")).items.length, 0);
      await page.getByRole("button", { name: "新建篝火", exact: true }).click();
      await title.fill(headline); await paragraph.fill(text);
      const created = page.waitForResponse(response => pathOf(response.url()) === "/api/admin/stories" && response.request().method() === "POST");
      await save.click(); assert.equal((await created).status(), 201); await state("saved");
      id = new URL(page.url()).searchParams.get("story"); assert.match(id ?? "", /^[a-f0-9-]{36}$/i);
      const detail = await api(`/api/admin/stories/${id}/draft`);
      assert.equal(detail.story.id, id); assert.equal(detail.story.kind, "CAMPFIRE"); assert.equal(detail.story.state, "DRAFT");
      assert.equal(detail.story.version, 0); assert.equal(detail.draft.title, headline);
      assert.equal(detail.draft.content.blocks[0].text, text);
      assert.equal(Object.hasOwn(detail.story, "slotId"), false);
      await page.evaluate(() => globalThis.scrollTo({ top: 0, behavior: "instant" })); await screenshot("desktop-first-campfire-top");
      await title.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
      await screenshot("desktop-first-campfire-saved");
    });
    await check("refresh restores the saved CAMPFIRE and keeps exactly one server story", async () => {
      assert.equal((await page.reload({ waitUntil: "domcontentloaded" })).status(), 200); await state("saved");
      assert.equal(await title.inputValue(), headline); assert.equal(await paragraph.inputValue(), text);
      assert.equal(new URL(page.url()).searchParams.get("story"), id);
      const list = await api("/api/admin/stories?limit=50"); assert.equal(list.items.length, 1);
      assert.equal(list.items[0].id, id); assert.equal(list.items[0].kind, "CAMPFIRE");
    });
    await check("a second CAMPFIRE is rejected by real HTTP 409 without losing unsaved input", async () => {
      await page.getByRole("button", { name: "新建篝火", exact: true }).click();
      await title.fill("合成第二篇篝火 · 应当被拒绝"); await paragraph.fill("此未保存内容必须保留，不会创建第二篇篝火。");
      expectedConflict = true;
      const rejected = page.waitForResponse(response => pathOf(response.url()) === "/api/admin/stories" && response.request().method() === "POST");
      await save.click(); assert.equal((await rejected).status(), 409); await state("conflict");
      assert.equal(await title.inputValue(), "合成第二篇篝火 · 应当被拒绝");
      assert.equal(await paragraph.inputValue(), "此未保存内容必须保留，不会创建第二篇篝火。");
      assert.equal(await save.isDisabled(), true);
      const list = await api("/api/admin/stories?limit=50"); assert.equal(list.items.length, 1); assert.equal(list.items[0].id, id);
      await title.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
      await screenshot("desktop-second-campfire-rejected");
    });
    await finalizeBrowserAudit();
    assert.ok(report.fetchAudit.inspected > 0);
    assert.equal(report.errors.length, 0); assert.equal(report.privacyViolations.length, 0); report.passed = true;
    return { passed: report.checks.length, total: 4, storyId: id };
  } catch (error) {
    report.failedAt = stage;
    report.failure = {
      kind: ["AssertionError", "TimeoutError", "Error"].includes(error?.name) ? error.name : "Error",
      source: /browser-tests\.mjs:\d+:\d+/.exec(error?.stack ?? "")?.[0] ?? "unknown",
      ...(typeof error?.operator === "string" ? { operator: error.operator } : {}),
      ...(["number", "boolean"].includes(typeof error?.expected) ? { expected: error.expected } : {}),
      ...(["number", "boolean"].includes(typeof error?.actual) ? { actual: error.actual } : {}),
    };
    await screenshot("fresh-campfire-failure").catch(() => {});
    throw new Error(`Fresh CAMPFIRE browser failed at ${stage}; sensitive details withheld`, { cause: error });
  } finally {
    await finalizeBrowserAudit();
    await writeFile(resolve(evidenceDirectory, "fresh-campfire-browser-results.json"), JSON.stringify(report, null, 2));
  }
}
