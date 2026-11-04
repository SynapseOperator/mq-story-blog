import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import { chromium } from "playwright";

/** No new publishing UI exists in P2-10A. These checks use content published by
 * the real HTTP tests and keep the accepted reader/editor appearance unchanged. */
export async function runPublishingBrowser({ baseURL, admin, first, evidenceDirectory }) {
  assert.equal(new URL(baseURL).hostname, "127.0.0.1"); assert.equal(new URL(baseURL).protocol, "https:");
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MQ_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.MQ_PLAYWRIGHT_EXECUTABLE } : {}) });
  if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
  const report = { browser: browser.version(), browserPath: "Browser plugin not available; locked Playwright Chromium",
    scope: "Synthetic publication HTTP result in the existing public reader and administrator editor", checks: [], screenshots: [], runtimeErrors: 0, passed: false };
  const contexts = [];
  try {
    for (const [name, viewport, extra] of [
      ["desktop", { width: 1536, height: 1024 }, {}],
      ["mobile-390", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }],
      ["mobile-320-reduced", { width: 320, height: 568 }, { isMobile: true, hasTouch: true, reducedMotion: "reduce" }],
    ]) {
      const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, ...extra }); contexts.push(context);
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      page.on("pageerror", () => { report.runtimeErrors++; });
      await page.goto(`${baseURL}/stories/${first.slug}`);
      const reader = page.locator('dialog.letter-dialog[data-mode="public"][data-phase="reading"]');
      await reader.waitFor(); await page.getByRole("heading", { name: first.title, exact: true }).waitFor();
      const image = reader.locator(".letter-prose img").first(); await image.waitFor();
      await image.evaluate(element => element.decode()); assert.ok(await image.evaluate(element => element.naturalWidth > 0));
      assert.equal(await page.locator(".account-controls").isVisible(), false);
      assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
      if (extra.reducedMotion) assert.equal(await page.evaluate(() => globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches), true);
      if (evidenceDirectory) {
        const file = `${name}-published-reader.png`; await page.screenshot({ path: resolve(evidenceDirectory, file), scale: "css" }); report.screenshots.push(file);
      }
      await page.reload(); await reader.waitFor(); await image.evaluate(element => element.decode());
      await page.getByRole("button", { name: "关闭羽毛信", exact: true }).click();
      await page.waitForURL(`${baseURL}/`); await reader.waitFor({ state: "detached" });
      await page.waitForFunction(() => !globalThis.document.querySelector(".account-controls button")?.disabled);
      await page.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
      const auth = page.locator(".auth-dialog");
      await auth.getByLabel("用户名", { exact: true }).fill(admin.username);
      await auth.getByLabel("密码", { exact: true }).fill(admin.password);
      await auth.locator(".auth-submit").click(); await auth.waitFor({ state: "detached" });
      const cookie = (await context.cookies()).find(item => item.name === "__Secure-mq.session_token");
      assert.ok(cookie?.secure && cookie.httpOnly);
      await page.goto(`${baseURL}/admin/stories?story=${first.id}`);
      await page.getByTestId("story-editor").waitFor();
      assert.equal(await page.getByLabel("故事标题", { exact: true }).inputValue(), first.title);
      assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
      assert.equal(await page.getByRole("button", { name: "保存草稿", exact: true }).count(), 1);
      if (evidenceDirectory) {
        const file = `${name}-unchanged-editor.png`; await page.screenshot({ path: resolve(evidenceDirectory, file), scale: "css" }); report.screenshots.push(file);
      }
      report.checks.push(`${name}: direct share, refresh, managed image decode, close home, HTTPS login and existing editor`);
    }
    assert.equal(report.runtimeErrors, 0); report.passed = true;
  } finally {
    await Promise.allSettled(contexts.map(context => context.close())); await browser.close();
    if (evidenceDirectory) await writeFile(resolve(evidenceDirectory, "publishing-browser-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}
