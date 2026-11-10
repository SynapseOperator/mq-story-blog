import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "/opt/mq-browser/node_modules/playwright-core/index.mjs";

// Runs only inside the isolated acceptance browser. Its NSS trust database
// contains the single disposable laboratory CA, never a host/system import.
const input = JSON.parse(await readFile("/fixture/input.json", "utf8"));
assert.equal(input.origin, "https://mq-story.xyz");
const browser = await chromium.launch({ headless: true,
  args: ["--host-resolver-rules=MAP mq-story.xyz 127.0.0.1", "--no-proxy-server"] });
const checks = [], sessions = [];
let stage = "browser-context";
try {
  for (const [name, viewport] of [["desktop", { width: 1536, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, ignoreHTTPSErrors: false,
      ...(name === "mobile" ? { isMobile: true, hasTouch: true, reducedMotion: "reduce" } : {}) });
    try {
      const page = await context.newPage(), errors = [];
      page.on("pageerror", () => errors.push("pageerror"));
      page.on("console", message => { if (message.type() === "error") errors.push("console" ); });
      stage = `${name}-trusted-navigation`;
      const response = await page.goto(input.origin);
      assert.equal(response.status(), 200); assert.equal(page.url(), `${input.origin}/`);
      assert.equal((await response.securityDetails()).issuer, "MQ isolated preview CA");
      assert.ok((await page.title()).includes("MQ"));
      assert.equal(await page.locator("nextjs-portal").count(), 0);
      stage = `${name}-login-dialog`;
      await page.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
      const dialog = page.locator(".auth-dialog");
      await dialog.getByLabel("用户名", { exact: true }).fill(input.admin.username);
      await dialog.getByLabel("密码", { exact: true }).fill(input.admin.password);
      await dialog.locator(".auth-submit").click();
      await dialog.waitFor({ state: "detached" });
      stage = `${name}-cookie-attributes`;
      const cookie = (await context.cookies()).find(item => item.name === "__Secure-mq.session_token");
      assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Lax");
      assert.equal(cookie.domain, "mq-story.xyz");
      sessions.push(`${cookie.name}=${cookie.value}`);
      stage = `${name}-admin-render`;
      await page.goto(`${input.origin}/admin`);
      assert.equal(await page.locator("nextjs-portal").count(), 0);
      await page.getByRole("heading", { name: /管理员|管理/ }).first().waitFor();
      assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
      await page.screenshot({ path: `/fixture/private-preview-${name}.png`, scale: "device" });
      stage = `${name}-console-health`;
      assert.deepEqual(errors, []);
      checks.push(`${name}: exact Origin, trusted TLS, real admin login, Secure/HttpOnly/Lax Cookie, rendered workspace`);
    } finally { await context.close(); }
  }
  // This private file is read by the parent only to verify revocation. It is
  // never copied into screenshots/evidence or emitted as terminal output.
  await writeFile("/fixture/sessions.json", JSON.stringify(sessions), { mode: 0o600 });
  await writeFile("/fixture/result.json", JSON.stringify({ verified: true, checks, ignoreHTTPSErrors: false }));
} catch {
  await writeFile("/fixture/result.json", JSON.stringify({ verified: false, stage }));
  console.error("PRIVATE_PREVIEW_BROWSER_FAILED");
  process.exitCode = 1;
} finally { await browser.close(); }
