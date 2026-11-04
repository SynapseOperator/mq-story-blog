import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { assertTemporaryTarget, likePath } from "./test-support.mjs";

/** Browser plugin not available; use the project's locked Playwright Chromium.
 * Flow: published letter -> guest heart -> nested login -> preserved reading
 * position/comment -> confirmed persistent like, including uncertain responses. */
export async function runLikeBrowserTests({ baseURL, connectionString, accounts, fixtures, evidenceDirectory }) {
  assertTemporaryTarget(connectionString);
  assert.equal(new URL(baseURL).hostname, "127.0.0.1"); assert.equal(new URL(baseURL).protocol, "https:");
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MQ_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.MQ_PLAYWRIGHT_EXECUTABLE } : {}) });
  const owner = new pg.Pool({ connectionString, max: 1 }), contexts = [];
  let passed = 0, screenshots = 0, stage = "setup";
  const errors = [];
  const url = `${baseURL}/stories/${fixtures.first.slug}`, endpoint = `${baseURL}${likePath(fixtures.first.id)}`;
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
  const check = async (name, action) => { stage = name; await action(); passed++; console.log(`PASS likes browser: ${name}`); };
  const reader = page => page.locator('dialog.letter-dialog[data-mode="public"][data-phase="reading"]');
  const heart = page => reader(page).locator(".letter-like");
  async function ready(page, count, liked) {
    await reader(page).locator('.letter-reactions[data-state="ready"]').waitFor();
    assert.equal(await heart(page).getAttribute("aria-pressed"), String(liked));
    assert.equal(await reader(page).locator(".letter-like-count").textContent(), String(count));
  }
  async function screenshot(page, name) {
    if (!evidenceDirectory) return;
    await page.screenshot({ path: resolve(evidenceDirectory, `${name}.png`), scale: "css" }); screenshots++;
  }
  async function makePage(viewport, extra = {}) {
    const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, ...extra }); contexts.push(context);
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    page.on("pageerror", () => errors.push("pageerror"));
    page.on("console", message => {
      if (message.type() === "error" && !/Failed to load resource|net::ERR_FAILED/.test(message.text())) errors.push("console error");
    });
    await page.goto(url); await reader(page).waitFor();
    assert.equal(page.url(), url); assert.match(await page.title(), /点赞与星光长信/);
    assert.equal(await page.locator("nextjs-portal").count(), 0);
    await page.getByRole("heading", { name: fixtures.first.title, exact: true }).waitFor();
    assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
    assert.equal(await page.locator(".account-controls").isVisible(), false);
    return page;
  }
  async function position(page) {
    return reader(page).locator(".letter-scroll").evaluate(element => ({ top: element.scrollTop,
      body: globalThis.scrollY, height: element.clientHeight, scrollHeight: element.scrollHeight }));
  }
  async function unchanged(page, before, draft, originalReader) {
    assert.equal(page.url(), url); await reader(page).waitFor();
    assert.equal(await originalReader.evaluate(element => element === globalThis.document.querySelector('dialog.letter-dialog[data-mode="public"]')), true);
    const after = await position(page);
    assert.ok(Math.abs(after.top - before.top) <= 2, "Nested authentication must retain the same reading position");
    assert.equal(after.body, before.body);
    assert.equal(await page.getByLabel("演示留言", { exact: true }).inputValue(), draft);
  }
  async function login(page, account) {
    const auth = page.locator(".auth-dialog[open]"); await auth.waitFor();
    await auth.getByLabel("用户名", { exact: true }).fill(account.username);
    await auth.getByLabel("密码", { exact: true }).fill(account.password);
    await auth.locator(".auth-submit").click(); await auth.waitFor({ state: "detached" });
    const cookie = (await page.context().cookies()).find(item => item.name === "__Secure-mq.session_token");
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Lax");
  }
  async function persisted(count) {
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM story_like WHERE story_id=$1", [fixtures.first.id])).rows[0].n, count);
  }
  try {
    for (const [name, viewport, extra] of [
      ["desktop", { width: 1536, height: 1024 }, {}],
      ["mobile-390", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }],
      ["mobile-320-reduced", { width: 320, height: 568 }, { isMobile: true, hasTouch: true, reducedMotion: "reduce" }],
    ]) {
      await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
      const page = await makePage(viewport, extra); await ready(page, 0, false);
      const originalReader = await reader(page).elementHandle(); assert.ok(originalReader);
      const draft = `仅演示、不发送：${name} 的合成留言草稿。`;
      await page.getByLabel("演示留言", { exact: true }).fill(draft);
      await heart(page).scrollIntoViewIfNeeded(); const before = await position(page);
      assert.ok(before.scrollHeight > before.height && before.top > 0);
      await check(`${name}: guest cancellation retains the letter, scroll, comment and heart focus`, async () => {
        await heart(page).click(); await page.locator(".auth-dialog[open]").waitFor();
        await screenshot(page, `${name}-nested-like-login`);
        await page.keyboard.press("Escape"); await page.locator(".auth-dialog").waitFor({ state: "detached" });
        await unchanged(page, before, draft, originalReader);
        assert.equal(await heart(page).evaluate(element => globalThis.document.activeElement === element), true);
        await persisted(0);
      });
      await check(`${name}: successful nested login reads current state without automatically liking`, async () => {
        let writes = 0;
        const track = request => { if (request.url() === endpoint && request.method() !== "GET") writes++; };
        page.on("request", track);
        try { await heart(page).click(); await login(page, accounts[0]); await ready(page, 0, false); }
        finally { page.off("request", track); }
        assert.equal(writes, 0); await persisted(0); await unchanged(page, before, draft, originalReader);
        assert.equal(await heart(page).evaluate(element => globalThis.document.activeElement === element), true);
      });
      await check(`${name}: confirmed like and unlike preserve comment content and PostgreSQL count`, async () => {
        await heart(page).click(); await ready(page, 1, true); await persisted(1);
        await unchanged(page, before, draft, originalReader); await screenshot(page, `${name}-confirmed-like`);
        await heart(page).click(); await ready(page, 0, false); await persisted(0);
        assert.equal(await page.getByLabel("演示留言", { exact: true }).inputValue(), draft);
      });
      if (name === "desktop") {
        await check("pending server ACK keeps the previous state and blocks duplicate activation", async () => {
          let release, committed;
          const gate = new Promise(done => { release = done; }), accepted = new Promise(done => { committed = done; });
          let writes = 0;
          const handler = async route => {
            if (route.request().method() !== "PUT") { await route.continue(); return; }
            writes++; const response = await route.fetch(); assert.equal(response.status(), 200); committed();
            await gate; await route.fulfill({ response });
          };
          await page.route(endpoint, handler);
          try {
            await heart(page).click(); await accepted;
            await reader(page).locator('.letter-reactions[data-state="saving"]').waitFor();
            assert.equal(await heart(page).isDisabled(), true);
            assert.equal(await heart(page).getAttribute("aria-pressed"), "false");
            assert.equal(await reader(page).locator(".letter-like-count").textContent(), "0");
            await heart(page).evaluate(element => { element.click(); element.click(); });
            await persisted(1); assert.equal(writes, 1); release(); await ready(page, 1, true);
          } finally { release(); await page.unroute(endpoint, handler); }
        });
        await check("lost committed DELETE response performs GET reconciliation without repeating the write", async () => {
          let writes = 0, reads = 0;
          const handler = async route => {
            if (route.request().method() !== "DELETE") { reads++; await route.continue(); return; }
            writes++; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort("failed");
          };
          await page.route(endpoint, handler);
          try {
            await heart(page).click(); await ready(page, 0, false); await persisted(0); assert.equal(writes, 1); assert.ok(reads >= 1);
            assert.match(await reader(page).locator(".letter-like-status").textContent(), /已读取当前状态；上次请求结果未确认/);
            await reader(page).getByRole("button", { name: "重新读取点赞状态", exact: true }).waitFor();
          }
          finally { await page.unroute(endpoint, handler); }
          assert.equal(await page.getByLabel("演示留言", { exact: true }).inputValue(), draft);
        });
        await check("unknown write plus failed read keeps the last confirmed count until explicit retry", async () => {
          let writes = 0, reads = 0;
          const handler = async route => {
            if (route.request().method() !== "GET") writes++; else reads++;
            await route.fulfill({ status: 503, contentType: "application/json", body: '{"code":"LIKES_UNAVAILABLE"}' });
          };
          await page.route(endpoint, handler);
          try {
            await heart(page).click(); await reader(page).locator('.letter-reactions[data-state="error"]').waitFor();
            assert.equal(await heart(page).isDisabled(), true); assert.equal(writes, 1); assert.ok(reads >= 1);
            assert.equal(await reader(page).locator(".letter-like-count").textContent(), "0");
            assert.equal(await page.getByLabel("演示留言", { exact: true }).inputValue(), draft);
            await persisted(0); await screenshot(page, "desktop-unknown-like-retry");
          } finally { await page.unroute(endpoint, handler); }
          await reader(page).getByRole("button", { name: "重新读取点赞状态", exact: true }).click(); await ready(page, 0, false);
        });
        await check("revoked browser session opens nested login and the same user recovers without losing reading state", async () => {
          await heart(page).scrollIntoViewIfNeeded(); const atExpiry = await position(page);
          const user = (await owner.query('SELECT id FROM "User" WHERE username=$1', [accounts[0].username])).rows[0];
          await owner.query('DELETE FROM "Session" WHERE "userId"=$1', [user.id]);
          await heart(page).click(); await page.locator(".auth-dialog[open]").waitFor();
          await login(page, accounts[0]); await ready(page, 0, false);
          await unchanged(page, atExpiry, draft, originalReader); await persisted(0);
        });
        await check("refresh and a new HTTPS login retain likes while another account stays unpressed", async () => {
          await heart(page).click(); await ready(page, 1, true);
          await page.getByLabel("演示留言", { exact: true }).fill("");
          await page.reload(); await reader(page).waitFor(); await ready(page, 1, true);
          const returning = await makePage({ width: 1536, height: 1024 }); await ready(returning, 1, false);
          await heart(returning).scrollIntoViewIfNeeded(); await heart(returning).click(); await login(returning, accounts[0]);
          await ready(returning, 1, true);
          await reader(returning).locator(".reader-account").getByRole("button", { name: "退出", exact: true }).click();
          await reader(returning).locator(".reader-account").getByRole("button", { name: "登录账号", exact: true }).waitFor();
          await ready(returning, 1, false);
          await heart(returning).click(); await login(returning, accounts[1]); await ready(returning, 1, false); await persisted(1);
          await reader(returning).locator(".reader-account").getByRole("button", { name: "退出", exact: true }).click();
          await reader(returning).locator(".reader-account").getByRole("button", { name: "登录账号", exact: true }).waitFor();
          await ready(returning, 1, false);
          await heart(returning).click(); await login(returning, accounts[0]); await ready(returning, 1, true);
          await heart(returning).click(); await ready(returning, 0, false); await persisted(0);
          await returning.context().close();
        });
        await check("failed initial count displays unknown instead of a fabricated zero, and retry recovers", async () => {
          const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true }); contexts.push(context);
          const unavailable = await context.newPage(); unavailable.setDefaultTimeout(20_000);
          unavailable.on("pageerror", () => errors.push("pageerror"));
          const handler = route => route.fulfill({ status: 503, contentType: "application/json", body: '{"code":"LIKES_UNAVAILABLE"}' });
          await unavailable.route(endpoint, handler); await unavailable.goto(url); await reader(unavailable).waitFor();
          await reader(unavailable).locator('.letter-reactions[data-state="error"]').waitFor();
          assert.equal(await reader(unavailable).locator(".letter-like-count").textContent(), "—");
          assert.equal(await heart(unavailable).isDisabled(), true);
          await unavailable.unroute(endpoint, handler);
          await reader(unavailable).getByRole("button", { name: "重新读取点赞状态", exact: true }).click(); await ready(unavailable, 0, false);
          await context.close();
        });
      }
      // Comment remains a local demonstration and still uses the original discard dialog.
      await page.getByLabel("演示留言", { exact: true }).fill(draft);
      await page.getByRole("button", { name: "关闭羽毛信", exact: true }).click();
      await page.getByRole("alertdialog").waitFor();
      await page.getByRole("button", { name: "继续编辑", exact: true }).click();
      assert.equal(await page.getByLabel("演示留言", { exact: true }).inputValue(), draft);
      await page.getByRole("button", { name: "关闭羽毛信", exact: true }).click();
      await page.getByRole("button", { name: "放弃并关闭", exact: true }).click();
      await page.waitForURL(`${baseURL}/`); await reader(page).waitFor({ state: "detached" });
      await page.context().close();
    }
    assert.deepEqual(errors, []); await persisted(0);
    return { passed, total: 15, screenshots };
  } catch (error) { error.likesStage = `browser: ${stage}`; throw error; }
  finally { await Promise.allSettled(contexts.map(context => context.close())); await browser.close(); await owner.end(); }
}
