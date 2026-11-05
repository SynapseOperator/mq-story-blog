import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { createStoryService } from "../../src/server/stories/service.ts";
import { revokeAdmin, restoreAdmin } from "../../src/server/admin/maintenance.ts";
import { assertTemporaryTarget, commentPath, moderatePath } from "./test-support.mjs";

/** Browser plugin not available. Use the locked Playwright Chromium against the
 * production HTTPS worker and this invocation's PostgreSQL database. Route
 * interception is limited to transport failures/delays; accepted data is real. */
export async function runCommentBrowserTests({ baseURL, connectionString, maintenanceUrl, admin, accounts, fixtures, evidenceDirectory }) {
  assertTemporaryTarget(connectionString); assertTemporaryTarget(maintenanceUrl);
  const origin = new URL(baseURL); assert.equal(origin.hostname, "127.0.0.1"); assert.equal(origin.protocol, "https:");
  const owner = new pg.Pool({ connectionString, max: 3 });
  const trusted = createAuthDatabaseClient(connectionString), maintenance = createAuthDatabaseClient(maintenanceUrl);
  const stories = createStoryService(trusted), contexts = [], errors = [], secrets = new Set(), privateText = new Set();
  for (const account of [admin, ...accounts]) secrets.add(account.password);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MQ_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.MQ_PLAYWRIGHT_EXECUTABLE } : {}) });
  let passed = 0, screenshots = 0, stage = "fixtures", lastStatus, activePage;
  const quota = () => owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
  const row = async id => (await owner.query("SELECT * FROM story_comment WHERE id=$1", [id])).rows[0];
  const bodyRows = async body => (await owner.query("SELECT * FROM story_comment WHERE body=$1 ORDER BY id", [body])).rows;
  const text = label => { const value = `合成 ${label} ${randomUUID()}`; privateText.add(value); return value; };
  const reader = page => page.locator('dialog.letter-dialog[data-mode="public"][data-phase="reading"]');
  const input = page => reader(page).getByLabel("留言内容", { exact: true });
  const sendButton = page => reader(page).locator('.letter-comment-actions button[type="submit"]');
  const retryButton = page => reader(page).getByRole("button", { name: "重试原提交", exact: true });
  const refreshButton = page => reader(page).getByRole("button", { name: "重新读取留言", exact: true });
  const exactRow = (page, id) => page.locator(`[data-testid="admin-comment-row"][data-comment-id="${id}"]`);
  async function readReady(page) { await reader(page).locator('.letter-comments-read-status[data-state="ready"]').waitFor({ state: "attached" }); }
  async function phase(page, state) { await reader(page).locator(`.letter-comment-submit-status[data-state="${state}"]`).waitFor(); }
  async function screenshot(page, name) {
    if (!evidenceDirectory) return;
    await page.screenshot({ path: resolve(evidenceDirectory, `${name}.png`), scale: "css" }); screenshots++;
    await page.screenshot({ path: resolve(evidenceDirectory, `${name}-dpr2.png`), scale: "device" }); screenshots++;
  }
  async function check(name, run) {
    stage = name; await quota(); await run(); passed++; console.log(`PASS comments browser: ${name}`);
  }
  async function makePage(viewport = { width: 1536, height: 1024 }, extra = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, ignoreHTTPSErrors: true, ...extra }); contexts.push(context);
    const page = await context.newPage(); page.setDefaultTimeout(20_000); activePage = page;
    page.on("pageerror", () => errors.push("pageerror"));
    page.on("console", message => {
      if (message.type() === "error" && !/Failed to load resource|net::ERR_FAILED|net::ERR_INTERNET_DISCONNECTED/.test(message.text())) errors.push("console error");
    });
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.origin === baseURL && /\/comments(?:\/|$)/.test(url.pathname)) lastStatus = { status: response.status(), method: response.request().method() };
    });
    page.on("request", request => {
      if (request.method() !== "POST" || !new URL(request.url()).pathname.endsWith("/comments")) return;
      const key = request.headers()["idempotency-key"];
      if (key) secrets.add(key);
      if (request.postData()) privateText.add(request.postData());
    });
    return page;
  }
  async function loginDialog(page, account) {
    const auth = page.locator(".auth-dialog[open]"); await auth.waitFor();
    await auth.getByLabel("用户名", { exact: true }).fill(account.username);
    await auth.getByLabel("密码", { exact: true }).fill(account.password);
    await auth.locator(".auth-submit").click(); await auth.waitFor({ state: "detached" });
    const cookie = (await page.context().cookies()).find(item => item.name === "__Secure-mq.session_token");
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Lax"); secrets.add(cookie.value);
  }
  async function loginHome(page, account) {
    await page.goto(baseURL);
    const button = page.locator(".account-controls").getByRole("button", { name: "登录", exact: true });
    await button.waitFor(); await button.click(); await loginDialog(page, account);
  }
  async function position(page) {
    return reader(page).locator(".letter-scroll").evaluate(element => ({ top: element.scrollTop, body: globalThis.scrollY,
      scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
      likes: element.querySelector(".letter-reactions")?.getAttribute("data-state") }));
  }
  async function unchanged(page, handle, before, draft) {
    activePage = page;
    assert.equal(await handle.evaluate(element => element === globalThis.document.querySelector('dialog.letter-dialog[data-mode="public"]')), true);
    const after = await position(page);
    if (Math.abs(after.top - before.top) > 2) {
      await reader(page).locator('.letter-reactions[data-state="ready"]').waitFor();
      console.error(`Comments scroll diagnostic: ${JSON.stringify({ before, after, likesReady: await position(page) })}`);
    }
    assert.ok(Math.abs(after.top - before.top) <= 2, "Nested account interaction retains reading position");
    assert.equal(after.body, before.body); assert.equal(await input(page).inputValue(), draft);
  }
  async function visibleCount(page, expected) {
    await readReady(page);
    const count = await reader(page).locator(".letter-public-comment-count").textContent();
    assert.match(count, new RegExp(`(^|\\D)${expected}(\\D|$)`));
  }
  async function approvedCount(storyId) {
    return (await owner.query("SELECT count(*)::int AS n FROM story_comment WHERE story_id=$1 AND state='APPROVED'", [storyId])).rows[0].n;
  }
  async function openReader(page, story) {
    activePage = page;
    await page.goto(`${baseURL}/stories/${story.slug}`); await reader(page).waitFor();
    await reader(page).getByRole("heading", { name: story.title, exact: true }).waitFor(); await readReady(page);
    assert.equal(page.url(), `${baseURL}/stories/${story.slug}`); assert.ok((await page.title()).includes(story.title));
    assert.equal(await page.locator("nextjs-portal").count(), 0);
    assert.equal(await page.locator(".account-controls").isVisible(), false);
    assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
  }
  async function submitUi(page, body) {
    privateText.add(body); await input(page).fill(body); await sendButton(page).click(); await phase(page, "accepted");
    assert.ok((await reader(page).locator(".letter-comment-submit-status").textContent()).includes("留言已提交，审核通过后会显示"));
    const rows = await bodyRows(body); assert.equal(rows.length, 1); return rows[0];
  }
  async function adminList(page, storyId, state = "PENDING") {
    activePage = page;
    await page.goto(`${baseURL}/admin/comments`); await page.getByTestId("comment-moderation-workspace").waitFor();
    await page.getByTestId("comment-story-filter").selectOption(storyId);
    await page.getByTestId("comment-state-filter").selectOption(state);
    const response = page.waitForResponse(item => {
      const url = new URL(item.url());
      return url.pathname === "/api/admin/comments" && url.searchParams.get("storyId") === storyId
        && url.searchParams.get("state") === state && item.request().method() === "GET";
    });
    await page.getByRole("button", { name: "刷新留言列表", exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.waitForFunction(() => !globalThis.document.querySelector('[data-testid="comment-story-filter"]')?.disabled);
  }
  async function decide(page, id, action, expected) {
    const line = exactRow(page, id); await line.waitFor();
    const response = page.waitForResponse(item => new URL(item.url()).pathname === moderatePath(id) && item.request().method() === "POST");
    await line.getByRole("button", { name: action, exact: true }).click(); assert.equal((await response).status(), 200);
    assert.equal((await row(id)).state, expected);
    await page.locator(`[data-testid="admin-comment-row"][data-comment-id="${id}"][data-state="${expected}"]`).waitFor();
  }
  async function logoutReader(page) {
    await reader(page).locator(".reader-account").getByRole("button", { name: "退出", exact: true }).click();
    await reader(page).locator(".reader-account").getByRole("button", { name: "登录账号", exact: true }).waitFor();
  }
  async function loginReader(page, account) {
    await reader(page).locator(".reader-account").getByRole("button", { name: "登录账号", exact: true }).click(); await loginDialog(page, account);
  }
  try {
    if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
    const draft = await stories.createDraft({ slug: `comments-browser-${randomUUID()}`, kind: "CAMPFIRE", title: "合成验收 · 留言与篝火长信",
      content: { version: 1, blocks: Array.from({ length: 24 }, (_, index) => ({ type: "paragraph",
        text: `第 ${index + 1} 段合成阅读文字。晚风经过青草山坡，篝火照亮信纸。这是隔离环境里的公开阅读、留言提交与审核测试，不包含真实姓名、回忆或私人照片。文字和留言始终在同一张信纸内连续滚动。` })) } });
    const story = { ...await stories.publish({ storyId: draft.id, expectedVersion: draft.version }), title: "合成验收 · 留言与篝火长信" };
    const url = `${baseURL}/stories/${story.slug}`, endpoint = `${baseURL}${commentPath(story.id)}`;
    const moderator = await makePage(); await quota(); await loginHome(moderator, admin);
    for (const [name, viewport, extra] of [
      ["desktop", { width: 1536, height: 1024 }, {}],
      ["mobile-390", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }],
      ["mobile-320", { width: 320, height: 568 }, { isMobile: true, hasTouch: true, reducedMotion: "reduce" }],
    ]) {
      const page = await makePage(viewport, extra); await openReader(page, story);
      const review = await makePage(viewport, extra); await quota(); await loginHome(review, admin);
      await check(`${name}: same letter, scroll and draft survive nested identity login cancellation and close cancellation`, async () => {
        const body = text(`${name}未提交草稿`); await input(page).fill(body);
        await reader(page).getByLabel("账号留言", { exact: true }).scrollIntoViewIfNeeded();
        const handle = await reader(page).elementHandle(), before = await position(page);
        assert.ok(before.top > 0); let writes = 0;
        const observe = request => { if (request.url() === endpoint && request.method() === "POST") writes++; };
        page.on("request", observe);
        try {
          await reader(page).getByLabel("账号留言", { exact: true }).check(); await page.locator(".auth-dialog[open]").waitFor();
          await screenshot(page, `${name}-nested-comment-login`);
          await page.keyboard.press("Escape"); await page.locator(".auth-dialog").waitFor({ state: "detached" });
          await unchanged(page, handle, before, body);
          await reader(page).getByRole("button", { name: "关闭羽毛信", exact: true }).click();
          await page.locator(".letter-discard[open]").waitFor();
          await page.getByRole("button", { name: "继续编辑", exact: true }).click();
          assert.equal(await input(page).inputValue(), body); assert.equal(writes, 0);
        } finally { page.off("request", observe); }
        await reader(page).getByLabel("匿名留言", { exact: true }).check();
      });
      await check(`${name}: pending ACK blocks duplicate submit and accepted anonymous receipt does not become a public item`, async () => {
        const body = text(`${name}匿名回执`), before = await approvedCount(story.id); let release, committed, writes = 0;
        const gate = new Promise(done => { release = done; }), accepted = new Promise(done => { committed = done; });
        const handler = async route => {
          if (route.request().method() !== "POST") return route.continue();
          writes++; const response = await route.fetch(); assert.equal(response.status(), 202); committed(); await gate; await route.fulfill({ response });
        };
        await page.route(endpoint, handler);
        try {
          await input(page).fill(body); await sendButton(page).click(); await accepted; await phase(page, "sending");
          assert.equal(await sendButton(page).isDisabled(), true);
          await sendButton(page).evaluate(button => { button.click(); button.click(); }); assert.equal(writes, 1);
          assert.equal((await bodyRows(body)).length, 1); release(); await phase(page, "accepted");
        } finally { release(); await page.unroute(endpoint, handler); }
        assert.equal(await input(page).inputValue(), ""); const stored = (await bodyRows(body))[0];
        assert.equal(stored.state, "PENDING"); assert.equal(stored.user_id, null);
        await visibleCount(page, before); assert.equal(await reader(page).locator(".letter-comment-item").filter({ hasText: body }).count(), 0);
        await screenshot(page, `${name}-pending-receipt`);
        await adminList(review, story.id); await decide(review, stored.id, "通过", "APPROVED");
        await refreshButton(page).click(); await visibleCount(page, before + 1);
        await reader(page).locator(".letter-comment-item").filter({ hasText: body }).waitFor();
        await screenshot(page, `${name}-approved-comments`);
      });
      await check(`${name}: administrator rejects pending and withdraws approved text through the real UI`, async () => {
        const rejectedBody = text(`${name}拒绝`), rejected = await submitUi(page, rejectedBody);
        await adminList(review, story.id); await decide(review, rejected.id, "拒绝", "REJECTED");
        const removedBody = text(`${name}撤回`), removed = await submitUi(page, removedBody);
        await adminList(review, story.id); await decide(review, removed.id, "通过", "APPROVED");
        await adminList(review, story.id, "APPROVED"); await screenshot(review, `${name}-moderation-workspace`);
        await decide(review, removed.id, "撤回", "WITHDRAWN");
        await refreshButton(page).click(); await readReady(page);
        for (const body of [rejectedBody, removedBody]) assert.equal(await reader(page).locator(".letter-comment-item").filter({ hasText: body }).count(), 0);
        assert.ok(await review.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
      });
      await check(`${name}: account login sends no comment, then explicit account submission displays only the public username`, async () => {
        const body = text(`${name}账号留言`); await input(page).fill(body); let writes = 0;
        await reader(page).getByLabel("账号留言", { exact: true }).scrollIntoViewIfNeeded();
        const handle = await reader(page).elementHandle(), before = await position(page);
        const observe = request => { if (request.url() === endpoint && request.method() === "POST") writes++; };
        page.on("request", observe);
        try {
          await reader(page).getByLabel("账号留言", { exact: true }).check();
          if (name !== "desktop") console.log(`Comments auth-open scroll: ${JSON.stringify(await position(page))}`);
          await loginDialog(page, accounts[0]);
          assert.equal(writes, 0); await unchanged(page, handle, before, body);
        } finally { page.off("request", observe); }
        const comment = await submitUi(page, body);
        const user = (await owner.query('SELECT id FROM "User" WHERE username=$1', [accounts[0].username])).rows[0];
        assert.equal(comment.user_id, user.id); assert.equal(comment.state, "PENDING");
        await adminList(review, story.id); await decide(review, comment.id, "通过", "APPROVED");
        await refreshButton(page).click(); await readReady(page);
        const item = reader(page).locator(".letter-comment-item").filter({ hasText: body }); await item.waitFor();
        assert.ok((await item.textContent()).includes(accounts[0].username));
        assert.ok(await item.evaluate(element => Number.parseFloat(globalThis.getComputedStyle(element).fontSize) >= 14));
        const layout = await reader(page).locator(".letter-comments").evaluate(section => ({
          overflow: section.scrollWidth - section.clientWidth,
          inputFont: Number.parseFloat(globalThis.getComputedStyle(section.querySelector("textarea")).fontSize),
          buttons: [...section.querySelectorAll("button")].filter(button => button.getBoundingClientRect().width).map(button => {
            const box = button.getBoundingClientRect(); return { width: box.width, height: box.height };
          }),
        }));
        assert.ok(layout.overflow <= 1); if (name !== "desktop") { assert.ok(layout.inputFont >= 16); assert.ok(layout.buttons.every(box => box.width >= 44 && box.height >= 44)); }
        await input(page).fill(""); await page.reload(); await reader(page).waitFor(); await readReady(page);
        await item.waitFor(); await screenshot(page, `${name}-account-comment`);
      });
      await page.context().close(); await review.context().close();
    }

    const page = await makePage(); await openReader(page, story);
    await check("committed but lost receipt retries the frozen key and body without clearing a later draft", async () => {
      const body = text("丢ACK原提交"), later = text("丢ACK之后新稿"), attempts = []; let lose = true;
      const handler = async route => {
        if (route.request().method() !== "POST") return route.continue();
        attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
        const response = await route.fetch(); assert.equal(response.status(), 202);
        if (lose) { lose = false; return route.abort("failed"); } return route.fulfill({ response });
      };
      await page.route(endpoint, handler);
      try {
        await input(page).fill(body); await sendButton(page).click(); await phase(page, "uncertain");
        assert.equal((await bodyRows(body)).length, 1); assert.equal(attempts.length, 1);
        await input(page).fill(later); assert.equal(attempts.length, 1);
        await screenshot(page, "desktop-unknown-receipt-new-draft");
        await retryButton(page).click(); await phase(page, "accepted");
        assert.equal(attempts.length, 2); assert.deepEqual(attempts[1], attempts[0]);
        assert.equal((await bodyRows(body)).length, 1); assert.equal(await input(page).inputValue(), later);
      } finally { await page.unroute(endpoint, handler); }
      await input(page).fill("");
    });
    await check("network failure leaves no row and clearing the draft still protects the unresolved submission", async () => {
      const body = text("断网原提交"); let writes = 0;
      const handler = async route => { if (route.request().method() !== "POST") return route.continue(); writes++; await route.abort("internetdisconnected"); };
      await page.route(endpoint, handler);
      try {
        await input(page).fill(body); await sendButton(page).click(); await phase(page, "uncertain");
        assert.equal((await bodyRows(body)).length, 0); assert.equal(writes, 1);
        await input(page).fill(""); await reader(page).getByRole("button", { name: "关闭羽毛信", exact: true }).click();
        await page.locator(".letter-discard[open]").waitFor(); await page.getByRole("button", { name: "继续编辑", exact: true }).click();
        await phase(page, "uncertain"); assert.equal(writes, 1);
      } finally { await page.unroute(endpoint, handler); }
      await retryButton(page).click(); await phase(page, "accepted"); assert.equal((await bodyRows(body)).length, 1);
    });
    await check("real 429 retains the frozen submission and Retry-After guidance until explicit retry", async () => {
      const body = text("限流保护");
      await submitUi(page, text("建立真实限流桶"));
      const handler = async route => { if (route.request().method() !== "POST") return route.continue(); await route.abort("failed"); };
      await page.route(endpoint, handler);
      try { await input(page).fill(body); await sendButton(page).click(); await phase(page, "uncertain"); }
      finally { await page.unroute(endpoint, handler); }
      await owner.query('UPDATE "AuthRateLimit" SET "count"=120');
      await retryButton(page).click();
      await reader(page).locator(".letter-comment-submit-status").filter({ hasText: /稍后|频繁|等待|限制/ }).waitFor();
      assert.equal(await input(page).inputValue(), body); assert.equal((await bodyRows(body)).length, 0);
      await quota(); await retryButton(page).click(); await phase(page, "accepted"); assert.equal((await bodyRows(body)).length, 1);
    });
    await check("real idempotency conflict is explicit and never changes or silently resends the draft", async () => {
      const body = text("幂等冲突原稿"), conflicting = text("同键另一正文"); let writes = 0;
      const handler = async route => {
        if (route.request().method() !== "POST") return route.continue();
        writes++;
        const seeded = await page.context().request.post(endpoint, { headers: { origin: baseURL,
          "idempotency-key": route.request().headers()["idempotency-key"] }, data: { body: conflicting, identity: "anonymous" } });
        assert.equal(seeded.status(), 202); const response = await route.fetch(); assert.equal(response.status(), 409); await route.fulfill({ response });
      };
      await page.route(endpoint, handler);
      try {
        await input(page).fill(body); await sendButton(page).click(); await phase(page, "error");
        assert.equal(await input(page).inputValue(), body); assert.equal(writes, 1);
        assert.equal((await bodyRows(body)).length, 0); assert.equal((await bodyRows(conflicting)).length, 1);
      } finally { await page.unroute(endpoint, handler); }
      await reader(page).getByRole("button", { name: "关闭羽毛信", exact: true }).click();
      await page.getByRole("button", { name: "放弃并关闭", exact: true }).click(); await reader(page).waitFor({ state: "detached" });
      await openReader(page, story);
    });
    await check("an unresolved account submission cannot be retried as a different signed-in account", async () => {
      await reader(page).getByLabel("账号留言", { exact: true }).check(); await loginDialog(page, accounts[0]);
      const body = text("账号A未确认请求"); let writes = 0;
      const observe = request => { if (request.url() === endpoint && request.method() === "POST") writes++; };
      page.on("request", observe);
      const handler = async route => { if (route.request().method() !== "POST") return route.continue(); await route.abort("failed"); };
      await page.route(endpoint, handler);
      try { await input(page).fill(body); await sendButton(page).click(); await phase(page, "uncertain"); }
      finally { await page.unroute(endpoint, handler); }
      await logoutReader(page); await loginReader(page, accounts[1]);
      assert.equal(await retryButton(page).isDisabled(), true);
      await reader(page).getByText("请登录原账号后重试这次提交。", { exact: true }).waitFor();
      assert.equal(writes, 1); assert.equal((await bodyRows(body)).length, 0);
      await logoutReader(page); await loginReader(page, accounts[0]); assert.equal(writes, 1);
      await retryButton(page).click(); await phase(page, "accepted"); assert.equal(writes, 2); page.off("request", observe);
      const user = (await owner.query('SELECT id FROM "User" WHERE username=$1', [accounts[0].username])).rows[0];
      assert.equal((await bodyRows(body))[0].user_id, user.id);
    });
    await check("revoked account Session preserves the submission through explicit login and retry", async () => {
      const body = text("Session撤销后保留");
      const handler = async route => { if (route.request().method() !== "POST") return route.continue(); await route.abort("failed"); };
      await page.route(endpoint, handler);
      try { await input(page).fill(body); await sendButton(page).click(); await phase(page, "uncertain"); }
      finally { await page.unroute(endpoint, handler); }
      const user = (await owner.query('SELECT id FROM "User" WHERE username=$1', [accounts[0].username])).rows[0];
      await owner.query('DELETE FROM "Session" WHERE "userId"=$1', [user.id]);
      await retryButton(page).click();
      await reader(page).locator(".letter-comment-submit-status").filter({ hasText: /登录|会话/ }).waitFor();
      assert.equal(await input(page).inputValue(), body); assert.equal((await bodyRows(body)).length, 0);
      // Explicitly returning through the existing account controls renews the same
      // identity. The component must never send a comment merely because of login.
      const auth = page.locator(".auth-dialog[open]");
      if (await auth.count()) await loginDialog(page, accounts[0]);
      else {
        const logout = reader(page).locator(".reader-account").getByRole("button", { name: "退出", exact: true });
        if (await logout.count()) await logoutReader(page);
        await loginReader(page, accounts[0]);
      }
      assert.equal((await bodyRows(body)).length, 0); await retryButton(page).click(); await phase(page, "accepted");
      assert.equal((await bodyRows(body)).length, 1);
    });
    await check("500 supplementary Unicode characters submit and 501 remain editable but cannot submit", async () => {
      await reader(page).getByLabel("匿名留言", { exact: true }).check();
      let writes = 0;
      const observe = request => { if (request.url() === endpoint && request.method() === "POST") writes++; };
      page.on("request", observe);
      // DOM composition events exercise the React guard; this is not an OS IME test.
      await input(page).dispatchEvent("compositionstart");
      await input(page).fill("🌟".repeat(501)); assert.equal(Array.from(await input(page).inputValue()).length, 501);
      assert.equal(await sendButton(page).isDisabled(), true);
      await input(page).fill("🌟".repeat(500)); assert.equal(await sendButton(page).isDisabled(), true);
      await reader(page).locator("form").dispatchEvent("submit"); assert.equal(writes, 0);
      assert.equal(Array.from(await input(page).inputValue()).length, 500);
      await input(page).dispatchEvent("compositionend"); assert.equal(await sendButton(page).isDisabled(), false);
      await sendButton(page).click(); await phase(page, "accepted");
      assert.equal(writes, 1); page.off("request", observe);
      const rows = await owner.query("SELECT count(*)::int AS n FROM story_comment WHERE story_id=$1 AND body=$2", [story.id, "🌟".repeat(500)]);
      assert.equal(rows.rows[0].n, 1);
    });
    await check("approved HTML-looking text renders as text nodes without executable elements", async () => {
      const body = '<img src=x onerror="globalThis.commentXss=1"><script>globalThis.commentXss=2</script> **纯文本**';
      const comment = await submitUi(page, body); await adminList(moderator, story.id); await decide(moderator, comment.id, "通过", "APPROVED");
      await refreshButton(page).click(); await readReady(page);
      const item = reader(page).locator(".letter-comment-item").filter({ hasText: body }); await item.waitFor();
      assert.ok((await item.textContent()).includes(body)); assert.equal(await item.locator("img,script,iframe").count(), 0);
      assert.equal(await page.evaluate(() => globalThis.commentXss), undefined);
    });
    await check("public pagination appends approved rows once and never displays private moderation data", async () => {
      const other = await makePage(); await openReader(other, { ...fixtures.second, title: "另一篇合成留言故事" });
      assert.equal(await reader(other).locator(".letter-comment-item").count(), 20);
      await reader(other).getByRole("button", { name: "加载更多留言", exact: true }).click();
      await other.waitForFunction(() => globalThis.document.querySelectorAll(".letter-comment-item").length === 22);
      assert.equal(await reader(other).getByRole("button", { name: "加载更多留言", exact: true }).count(), 0);
      assert.equal((await reader(other).textContent()).includes("PRIVATE_PENDING_PAGE_CANARY"), false);
      await other.context().close();
    });
    await check("administrator pagination appends 20 to 22 unique rows and changing the filter drops the previous state", async () => {
      const other = await makePage(); await other.context().addCookies(await moderator.context().cookies());
      await adminList(other, fixtures.second.id, "APPROVED");
      const rows = other.getByTestId("admin-comment-row"); assert.equal(await rows.count(), 20);
      await other.getByRole("button", { name: "更多留言", exact: true }).click();
      await other.waitForFunction(() => globalThis.document.querySelectorAll('[data-testid="admin-comment-row"]').length === 22);
      const ids = await rows.evaluateAll(elements => elements.map(element => element.getAttribute("data-comment-id")));
      assert.equal(new Set(ids).size, 22); assert.equal(await other.getByRole("button", { name: "更多留言", exact: true }).count(), 0);
      const approved = (await owner.query("SELECT id FROM story_comment WHERE story_id=$1 AND state='APPROVED'", [fixtures.second.id])).rows.map(row => row.id);
      assert.deepEqual([...ids].sort(), approved.sort());
      const response = other.waitForResponse(item => {
        const url = new URL(item.url());
        return url.pathname === "/api/admin/comments" && url.searchParams.get("storyId") === fixtures.second.id
          && url.searchParams.get("state") === "PENDING" && item.request().method() === "GET";
      });
      await other.getByTestId("comment-state-filter").selectOption("PENDING"); assert.equal((await response).status(), 200);
      await other.waitForFunction(() => !globalThis.document.querySelector('[data-testid="comment-state-filter"]').disabled);
      const pending = (await owner.query("SELECT id FROM story_comment WHERE story_id=$1 AND state='PENDING'", [fixtures.second.id])).rows.map(row => row.id);
      assert.ok(pending.length > 0 && pending.length <= 20);
      const current = await rows.evaluateAll(elements => elements.map(element => element.getAttribute("data-comment-id")));
      assert.deepEqual(current.sort(), pending.sort()); assert.ok(current.every(id => !ids.includes(id)));
      await other.context().close();
    });
    await check("failed initial list shows unknown count and preserves an editable draft until explicit retry", async () => {
      const other = await makePage(), body = text("读取失败仍保留草稿");
      const handler = route => route.fulfill({ status: 503, contentType: "application/json", body: '{"code":"COMMENT_UNAVAILABLE"}' });
      await other.route(endpoint, handler); await other.goto(url); await reader(other).waitFor();
      await reader(other).locator('.letter-comments-read-status[data-state="error"]').waitFor();
      assert.ok((await reader(other).locator(".letter-public-comment-count").textContent()).includes("—"));
      await input(other).fill(body); await other.unroute(endpoint, handler);
      await refreshButton(other).click(); await readReady(other); assert.equal(await input(other).inputValue(), body);
      await input(other).fill(""); await other.context().close();
    });
    await check("moderation committed without ACK requires an exact reread and never automatically repeats the decision", async () => {
      const comment = await submitUi(page, text("审核丢ACK")); await adminList(moderator, story.id); let writes = 0, reads = 0;
      const routeUrl = `${baseURL}${moderatePath(comment.id)}`;
      const handler = async route => { writes++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("failed"); };
      const observe = request => { const url = new URL(request.url()); if (url.pathname === "/api/admin/comments" && url.searchParams.get("commentId") === comment.id) reads++; };
      moderator.on("request", observe); await moderator.route(routeUrl, handler);
      try {
        const line = exactRow(moderator, comment.id); await line.getByRole("button", { name: "通过", exact: true }).click();
        await line.getByRole("button", { name: "重新读取此留言", exact: true }).waitFor();
        assert.equal((await row(comment.id)).state, "APPROVED"); assert.equal(writes, 1); assert.equal(reads, 0);
        assert.equal(await line.getByRole("button", { name: "通过", exact: true }).isDisabled(), true);
        await screenshot(moderator, "desktop-moderation-unknown");
        await line.getByRole("button", { name: "重新读取此留言", exact: true }).click();
        await line.getByRole("button", { name: "撤回", exact: true }).waitFor(); assert.equal(reads, 1); assert.equal(writes, 1);
      } finally { await moderator.unroute(routeUrl, handler); moderator.off("request", observe); }
    });
    await check("a real second decision produces 409 while the original row stays locked until explicit exact reread", async () => {
      const comment = await submitUi(page, text("审核CAS冲突")); await adminList(moderator, story.id);
      const other = await moderator.context().request.post(`${baseURL}${moderatePath(comment.id)}`, {
        headers: { origin: baseURL }, data: { action: "reject", expectedVersion: 0 },
      }); assert.equal(other.status(), 200);
      const line = exactRow(moderator, comment.id); const response = moderator.waitForResponse(item => new URL(item.url()).pathname === moderatePath(comment.id));
      await line.getByRole("button", { name: "通过", exact: true }).click(); assert.equal((await response).status(), 409);
      await line.getByRole("button", { name: "重新读取此留言", exact: true }).waitFor();
      assert.equal(await line.getByRole("button", { name: "通过", exact: true }).isDisabled(), true);
      await line.getByRole("button", { name: "重新读取此留言", exact: true }).click();
      await line.getByText("已拒绝", { exact: true }).waitFor(); assert.equal((await row(comment.id)).version, 1);
    });
    await check("administrator revocation denies the real UI write and a fresh login restores only explicit authority", async () => {
      const comment = await submitUi(page, text("后台撤权拒绝")); await adminList(moderator, story.id);
      let grant = (await owner.query('SELECT "userId",version FROM "AdminGrant" WHERE id=1')).rows[0];
      grant = await revokeAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      const response = moderator.waitForResponse(item => new URL(item.url()).pathname === moderatePath(comment.id));
      await exactRow(moderator, comment.id).getByRole("button", { name: "通过", exact: true }).click();
      assert.equal((await response).status(), 401); assert.equal((await row(comment.id)).state, "PENDING");
      await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
      await moderator.context().clearCookies(); await loginHome(moderator, admin);
      await adminList(moderator, story.id); await decide(moderator, comment.id, "通过", "APPROVED");
    });
    await check("sharing Back and Forward retain unsubmitted text on cancellation and discard only after confirmation", async () => {
      const navigation = await makePage(); await navigation.goto(baseURL);
      await navigation.locator(`.story-entry[data-story-id="${story.id}"]`).click(); await reader(navigation).waitFor(); await readReady(navigation);
      const body = text("历史导航保留草稿"); await input(navigation).fill(body);
      const before = await position(navigation), length = await navigation.evaluate(() => globalThis.history.length);
      await navigation.evaluate(() => globalThis.history.back()); await navigation.locator(".letter-discard[open]").waitFor();
      await navigation.getByRole("button", { name: "继续编辑", exact: true }).click(); await navigation.waitForURL(url);
      assert.equal(await input(navigation).inputValue(), body); assert.ok(Math.abs((await position(navigation)).top - before.top) <= 2);
      assert.equal(await navigation.evaluate(() => globalThis.history.length), length);
      await navigation.evaluate(() => globalThis.history.back()); await navigation.locator(".letter-discard[open]").waitFor();
      await navigation.getByRole("button", { name: "放弃并关闭", exact: true }).click();
      await navigation.waitForURL(`${baseURL}/`); await navigation.locator('dialog.letter-dialog[data-mode="public"]').waitFor({ state: "detached" });
      await navigation.evaluate(() => globalThis.history.forward()); await navigation.waitForURL(url); await reader(navigation).waitFor(); await readReady(navigation);
      assert.equal(await input(navigation).inputValue(), ""); assert.equal(await navigation.evaluate(() => globalThis.history.length), length);
      await navigation.context().close();
    });
    await check("refresh and a new HTTPS login show persisted approved comments without local draft storage", async () => {
      await input(page).fill(""); await page.reload(); await reader(page).waitFor(); await readReady(page);
      await visibleCount(page, await approvedCount(story.id));
      const returning = await makePage(); await openReader(returning, story); await loginReader(returning, accounts[1]);
      await visibleCount(returning, await approvedCount(story.id)); assert.equal(await input(returning).inputValue(), "");
      for (const target of [page, returning]) {
        const stored = await target.evaluate(() => JSON.stringify({ local: { ...globalThis.localStorage }, session: { ...globalThis.sessionStorage }, history: globalThis.history.state }));
        for (const value of privateText) assert.ok(!stored.includes(value));
      }
      await returning.context().close();
    });
    await check("withdrawal hides public comments and blocks retry while restore retains only approved records", async () => {
      const body = text("下架时保留草稿"); await input(page).fill(body);
      const handler = async route => { if (route.request().method() !== "POST") return route.continue(); await route.abort("failed"); };
      await page.route(endpoint, handler);
      try { await sendButton(page).click(); await phase(page, "uncertain"); }
      finally { await page.unroute(endpoint, handler); }
      let current = await trusted.story.findUniqueOrThrow({ where: { id: story.id } });
      current = await stories.withdraw({ storyId: current.id, expectedVersion: current.version });
      const response = page.waitForResponse(item => item.url() === endpoint && item.request().method() === "POST");
      await retryButton(page).click(); assert.equal((await response).status(), 404);
      await reader(page).locator(".letter-comment-submit-status").filter({ hasText: "这篇故事暂未公开或已下架" }).waitFor();
      await phase(page, "uncertain"); assert.equal((await bodyRows(body)).length, 0);
      await refreshButton(page).click(); await reader(page).locator('.letter-comments-read-status[data-state="unavailable"]').waitFor();
      assert.equal(await input(page).inputValue(), body); assert.equal(await reader(page).locator(".letter-comment-item").count(), 0);
      await stories.restore({ storyId: current.id, expectedVersion: current.version });
      await refreshButton(page).click(); await readReady(page); assert.equal(await input(page).inputValue(), body);
      await visibleCount(page, await approvedCount(story.id)); await retryButton(page).click(); await phase(page, "accepted");
      assert.equal((await bodyRows(body)).length, 1);
    });
    if (evidenceDirectory) {
      stage = "natural Chinese synthetic presentation screenshots";
      await quota();
      // The three scene slots are fixed. Reuse the completed HTTP suite's empty,
      // withdrawn star-3 fixture; do not invent an unsupported scene mapping.
      let draft = await trusted.story.findUniqueOrThrow({ where: { id: fixtures.withdrawn.id } });
      assert.equal(draft.state, "WITHDRAWN");
      assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_comment WHERE story_id=$1", [draft.id])).rows[0].n, 0);
      draft = await stories.saveDraft({ storyId: draft.id, expectedVersion: draft.version, title: "合成样例 · 晚风里的回信",
        content: { version: 1, blocks: [
          { type: "paragraph", text: "这是用于界面检查的合成故事，不对应真实人物或经历。" },
          { type: "paragraph", text: "傍晚的风吹过山坡，我们把今天的小事写进一封信：路边新开的花、慢慢亮起的星，还有一句没来得及说的谢谢。" },
          { type: "paragraph", text: "愿每一次认真阅读，都能在这里留下温柔的回声。" },
        ] } });
      draft = await stories.restore({ storyId: draft.id, expectedVersion: draft.version });
      const sample = { ...await stories.publish({ storyId: draft.id, expectedVersion: draft.version }), title: "合成样例 · 晚风里的回信" };
      for (const [body, approved] of [
        ["【合成留言】读到这里，想起傍晚散步时的微风。谢谢你把平凡的小事写得这样温柔。", true],
        ["【合成留言】愿这封信陪你度过一个安静的夜晚，明天也有值得期待的小事。", false],
      ]) {
        privateText.add(body); const key = randomUUID(); secrets.add(key);
        const response = await page.context().request.post(`${baseURL}${commentPath(sample.id)}`, {
          headers: { origin: baseURL, "idempotency-key": key }, data: { body, identity: "anonymous" },
        }); assert.equal(response.status(), 202);
        const { receiptId } = await response.json();
        if (approved) { await adminList(moderator, sample.id); await decide(moderator, receiptId, "通过", "APPROVED"); }
      }
      for (const [name, viewport, extra] of [
        ["desktop", { width: 1536, height: 1024 }, {}],
        ["mobile-390", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }],
        ["mobile-320", { width: 320, height: 568 }, { isMobile: true, hasTouch: true }],
      ]) {
        const example = await makePage(viewport, extra); await openReader(example, sample);
        await reader(example).locator(".letter-comment-item").scrollIntoViewIfNeeded(); await visibleCount(example, 1);
        await screenshot(example, `${name}-example-public-comments`);
        await example.context().addCookies(await moderator.context().cookies());
        await adminList(example, sample.id); await screenshot(example, `${name}-example-moderation`);
        assert.ok(await example.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
        await example.context().close();
      }
    }
    assert.equal(errors.length, 0);
    const privateValues = (await owner.query('SELECT token AS value FROM "Session" UNION ALL SELECT email AS value FROM "User" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
    privateValues.forEach(item => secrets.add(item.value));
    const cookie = (await moderator.context().cookies()).find(item => item.name === "__Secure-mq.session_token"); assert.ok(cookie);
    return { passed, total: 29, screenshots, secrets, privateText, adminJar: { cookie: `${cookie.name}=${cookie.value}` } };
  } catch (error) {
    await screenshot(activePage, "failed-browser-state").catch(() => {});
    const location = error.stack?.split("\n").filter(line => line.trim().startsWith("at ") && /scripts[\\/]comments[\\/]browser-tests/.test(line)).slice(0, 3);
    console.error(`Comments browser diagnostic: ${JSON.stringify({ stage, ...lastStatus, location,
      actual: typeof error.actual === "number" || typeof error.actual === "boolean" ? error.actual : undefined,
      expected: typeof error.expected === "number" || typeof error.expected === "boolean" ? error.expected : undefined })}`);
    error.commentsStage = stage; throw error;
  } finally {
    await Promise.allSettled(contexts.map(context => context.close())); await browser.close();
    await Promise.allSettled([owner.end(), trusted.$disconnect(), maintenance.$disconnect()]);
  }
}
