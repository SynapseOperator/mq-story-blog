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
  let passed = 0, screenshots = 0, stage = "setup", lastLayout;
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
    await page.screenshot({ path: resolve(evidenceDirectory, `${name}-dpr2.png`), scale: "device" }); screenshots++;
  }
  async function makePage(viewport, extra = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, ignoreHTTPSErrors: true, ...extra }); contexts.push(context);
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    page.on("pageerror", () => errors.push("pageerror"));
    page.on("console", message => {
      if (message.type() === "error" && !/Failed to load resource|net::ERR_FAILED/.test(message.text())) errors.push("console error");
    });
    await page.goto(url); await reader(page).waitFor();
    // Reduced motion can finish opening before the async article has loaded.
    // Its exact heading proves content/title readiness, not just animation state.
    await page.getByRole("heading", { name: fixtures.first.title, exact: true }).waitFor();
    assert.equal(page.url(), url); assert.match(await page.title(), /点赞与星光长信/);
    assert.equal(await page.locator("nextjs-portal").count(), 0);
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
    if (Math.abs(after.top - before.top) > 2) {
      lastLayout = { readingBefore: before, readingAfter: after };
      await screenshot(page, "failed-reading-position");
    }
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
  async function dialogLayout(page, mode) {
    const auth = page.locator(`.auth-dialog[open][data-appearance="reader"][data-mode="${mode}"]`);
    await auth.waitFor();
    lastLayout = await auth.evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      const targets = [...dialog.querySelectorAll("input,.auth-close,.auth-submit,.auth-switch button")].map(element => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      });
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        viewportWidth: globalThis.innerWidth, viewportHeight: globalThis.innerHeight,
        clientWidth: dialog.clientWidth, scrollWidth: dialog.scrollWidth,
        clientHeight: dialog.clientHeight, scrollHeight: dialog.scrollHeight,
        pageOverflow: globalThis.document.documentElement.scrollWidth - globalThis.innerWidth, targets };
    });
    assert.ok(lastLayout.width <= Math.min(328, lastLayout.viewportWidth - 56) + 1, "Reader authentication retains visible paper at both sides");
    assert.ok(lastLayout.x >= 27 && lastLayout.x + lastLayout.width <= lastLayout.viewportWidth - 27);
    assert.ok(lastLayout.y >= 0 && lastLayout.y + lastLayout.height <= lastLayout.viewportHeight + 1);
    assert.ok(lastLayout.scrollWidth <= lastLayout.clientWidth + 1 && lastLayout.pageOverflow <= 1, "Only vertical dialog scrolling is allowed");
    assert.ok(lastLayout.targets.every(target => target.width >= 44 && target.height >= 44), "Authentication inputs and buttons retain 44px touch targets");
    return auth;
  }
  try {
    for (const [name, viewport, extra] of [
      ["desktop", { width: 1536, height: 1024 }, {}],
      ["mobile-390", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }],
      ["mobile-320-reduced", { width: 320, height: 568 }, { isMobile: true, hasTouch: true, reducedMotion: "reduce" }],
    ]) {
      stage = `${name}: direct reader initialization`;
      await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
      const page = await makePage(viewport, extra); await ready(page, 0, false);
      if (name === "desktop") await screenshot(page, "desktop-reader");
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
        if (name !== "desktop") {
          const targets = await reader(page).locator(".letter-like,.letter-close,.reader-account button,.letter-comment-actions button").evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height };
          }));
          assert.ok(targets.every(target => target.width >= 44 && target.height >= 44), "Mobile reader actions, including logout, retain 44px touch targets");
          const identityWidth = await reader(page).locator(".reader-account").evaluate(element => {
            const label = element.querySelector(".account-username"), button = element.querySelector("button");
            const gap = Number.parseFloat(globalThis.getComputedStyle(element).columnGap);
            const nameMaxWidth = Number.parseFloat(globalThis.getComputedStyle(label).maxWidth), buttonWidth = button.getBoundingClientRect().width;
            return { containerWidth: element.clientWidth, currentNameWidth: label.getBoundingClientRect().width,
              nameMaxWidth, buttonWidth, gap, remainingNameWidth: element.clientWidth - buttonWidth - gap,
              maximumNameFitsOneRow: nameMaxWidth + buttonWidth + gap <= element.clientWidth + 1 };
          });
          console.log(`Likes reader identity width ${name}: ${JSON.stringify(identityWidth)}`);
        }
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
          const context = await browser.newContext({ viewport, deviceScaleFactor: 2, ignoreHTTPSErrors: true }); contexts.push(context);
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
    for (const [name, viewport, shortViewport] of [
      ["mobile-390", { width: 390, height: 844 }, { width: 390, height: 420 }],
      ["mobile-320", { width: 320, height: 568 }, { width: 320, height: 360 }],
    ]) {
      const page = await makePage(viewport, { isMobile: true, hasTouch: true }); await ready(page, 0, false);
      const originalReader = await reader(page).elementHandle(); assert.ok(originalReader);
      const draft = `合成留言：${name} 紧凑窗口切换后仍保留。`;
      await page.getByLabel("演示留言", { exact: true }).fill(draft);
      await heart(page).scrollIntoViewIfNeeded(); const before = await position(page);
      const comments = await reader(page).locator(".letter-comments").evaluate(section => {
        const fonts = ["p#letter-comment-help", ".reader-account", "textarea", ".letter-comment-actions > span", ".letter-comment-actions button", ".letter-sample-comment"]
          .map(selector => Number.parseFloat(globalThis.getComputedStyle(section.querySelector(selector)).fontSize));
        const count = section.querySelector(".letter-comment-actions > span").getBoundingClientRect();
        const submit = section.querySelector(".letter-comment-actions button").getBoundingClientRect();
        const targets = [...section.querySelectorAll(".reader-account button,.letter-comment-actions button")].map(element => {
          const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height };
        });
        return { fonts, targets, actionsOverlap: count.left < submit.right && submit.left < count.right && count.top < submit.bottom && submit.top < count.bottom };
      });
      assert.ok(comments.fonts.every((size, index) => size >= [12, 14, 16, 12, 14, 14][index]), "Mobile comment copy and input keep the intended readable sizes");
      assert.ok(comments.targets.every(target => target.width >= 44 && target.height >= 44));
      assert.equal(comments.actionsOverlap, false, "Comment count and preview button must wrap without overlap");
      for (const mode of ["login", "register"]) {
        await check(`${name}: compact ${mode} stays usable in a shortened viewport and preserves reading state`, async () => {
          await heart(page).click();
          if (mode === "register") await page.locator(".auth-dialog[open] .auth-switch button").click();
          let auth = await dialogLayout(page, mode);
          if (mode === "register") {
            const originalAuth = await auth.elementHandle(); assert.ok(originalAuth);
            await auth.locator(".auth-switch button").click(); await dialogLayout(page, "login");
            await page.locator(".auth-dialog[open] .auth-switch button").click(); auth = await dialogLayout(page, "register");
            assert.equal(await originalAuth.evaluate(element => element === globalThis.document.querySelector(".auth-dialog[open]")), true);
          }
          await screenshot(page, `${name}-compact-${mode}`);
          await auth.getByLabel("用户名", { exact: true }).focus();
          for (let index = 0; index < (mode === "register" ? 6 : 5); index++) {
            await page.keyboard.press("Tab");
            const focus = await auth.evaluate(dialog => ({ inside: dialog.contains(globalThis.document.activeElement),
              browserBoundary: globalThis.document.activeElement === globalThis.document.body }));
            // Native Chromium dialogs allow Tab through the browser chrome;
            // activeElement is BODY at that boundary, never a background control.
            assert.ok(focus.inside || focus.browserBoundary, "Keyboard focus cannot enter the underlying reader or page");
            if (focus.browserBoundary) {
              await page.keyboard.press("Tab");
              assert.equal(await auth.evaluate(dialog => dialog.contains(globalThis.document.activeElement)), true, "Tab returns from the browser boundary to the account dialog");
            }
          }
          const inertReader = await auth.evaluate(dialog => {
            const focused = globalThis.document.activeElement, close = dialog.closest(".letter-dialog").querySelector(".letter-close");
            close.focus({ preventScroll: true });
            return { enabled: !close.disabled, focusPreserved: globalThis.document.activeElement === focused };
          });
          assert.equal(inertReader.enabled, true); assert.equal(inertReader.focusPreserved, true, "The underlying reader remains inert while the account modal is open");
          // A shortened layout viewport approximates reduced available space;
          // this is not an actual operating-system keyboard or IME test.
          await page.setViewportSize(shortViewport);
          await page.evaluate(() => new Promise(done => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(done))));
          auth = await dialogLayout(page, mode);
          const field = auth.getByLabel(mode === "register" ? "确认密码" : "密码", { exact: true });
          await field.focus(); await field.scrollIntoViewIfNeeded();
          assert.equal(await field.evaluate(element => globalThis.document.activeElement === element), true);
          const visible = await field.evaluate(element => {
            const rect = element.getBoundingClientRect(), dialog = element.closest("dialog").getBoundingClientRect();
            return rect.top >= Math.max(0, dialog.top) && rect.bottom <= Math.min(globalThis.innerHeight, dialog.bottom) + 1;
          });
          assert.equal(visible, true, "Focused field is reachable within the shortened viewport");
          await screenshot(page, `${name}-compact-${mode}-short-viewport`);
          await auth.locator(".auth-submit").scrollIntoViewIfNeeded();
          await auth.locator(".auth-submit").click({ trial: true });
          await auth.locator(".auth-close").scrollIntoViewIfNeeded();
          await auth.locator(".auth-close").click(); await auth.waitFor({ state: "detached" });
          await page.setViewportSize(viewport);
          await page.evaluate(() => new Promise(done => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(done))));
          await unchanged(page, before, draft, originalReader);
          assert.equal(await heart(page).evaluate(element => globalThis.document.activeElement === element), true);
          await persisted(0);
        });
      }
      await page.context().close();
    }
    await check("homepage login retains the normal appearance, introduction and complete footer", async () => {
      const context = await browser.newContext({ viewport: { width: 1536, height: 1024 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true }); contexts.push(context);
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      page.on("pageerror", () => errors.push("pageerror"));
      await page.goto(`${baseURL}/`);
      await page.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
      const auth = page.locator('.auth-dialog[open][data-appearance="default"]'); await auth.waitFor();
      assert.equal(await auth.locator(".auth-intro").isVisible(), true);
      assert.equal(await auth.locator(".auth-footnote-full").isVisible(), true);
      assert.match(await auth.locator(".auth-footnote-full").textContent(), /无需邮箱/);
      await page.keyboard.press("Escape"); await auth.waitFor({ state: "detached" });
      assert.equal(page.url(), `${baseURL}/`); await context.close();
    });
    assert.deepEqual(errors, []); await persisted(0);
    return { passed, total: 20, screenshots };
  } catch (error) {
    const location = error.stack?.split("\n").filter(line => line.trim().startsWith("at ") && /scripts[\\/]likes[\\/]/.test(line)).slice(0, 2);
    console.error(`Likes browser diagnostic: ${JSON.stringify({ layout: lastLayout, location,
      actual: typeof error.actual === "number" || typeof error.actual === "boolean" ? error.actual : undefined,
      expected: typeof error.expected === "number" || typeof error.expected === "boolean" ? error.expected : undefined })}`);
    error.likesStage = `browser: ${stage}`; throw error;
  }
  finally { await Promise.allSettled(contexts.map(context => context.close())); await browser.close(); await owner.end(); }
}
