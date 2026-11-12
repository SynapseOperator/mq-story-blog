import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import pg from "pg";
import { chromium } from "playwright";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { restoreAdmin } from "../../src/server/admin/maintenance.ts";
import { assertTemporaryTarget } from "../admin-drafts/test-support.mjs";

/** Continues the existing isolated publishing suite, never a deployed database. */
export async function runStarSlotsBrowser({ baseURL, connectionString, maintenanceUrl, admin, privateValues, evidenceDirectory }) {
  assertTemporaryTarget(connectionString); assertTemporaryTarget(maintenanceUrl);
  assert.equal(new URL(baseURL).hostname, "127.0.0.1");
  assert.equal(new URL(baseURL).protocol, "https:");
  const owner = new pg.Pool({ connectionString, max: 1 });
  const maintenance = createAuthDatabaseClient(maintenanceUrl);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.MQ_PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.MQ_PLAYWRIGHT_EXECUTABLE } : {}) });
  const contexts = [], expected = Array.from({ length: 7 }, (_, i) => `star-${i + 1}`);
  const report = { browser: browser.version(), browserPath: "Browser plugin not available; locked Playwright Chromium",
    scope: "Seven real database slots, administrator publishing and public scene", checks: [], screenshots: [], views: [], passed: false };
  const failures = [], allowed = new Set(); let stage = "setup", page;
  async function api(path, { method = "GET", body, anonymous = false } = {}) {
    return page.evaluate(async ({ path, method, body, anonymous }) => {
      const r = await globalThis.fetch(path, { method, cache: "no-store", credentials: anonymous ? "omit" : "same-origin",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      return { status: r.status, data: await r.json() };
    }, { path, method, body, anonymous });
  }
  async function makePage(viewport, options = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, ignoreHTTPSErrors: true, ...options }); contexts.push(context);
    const next = await context.newPage(); next.setDefaultTimeout(20000);
    next.on("pageerror", () => failures.push("runtime"));
    next.on("console", event => {
      if (["error", "warning"].includes(event.type()) && !allowed.has(new URL(event.location().url || baseURL).pathname)) failures.push(event.type());
    });
    return next;
  }
  async function screenshot(view, name) {
    if (!evidenceDirectory) return;
    const file = `${name}.png`; await view.screenshot({ path: resolve(evidenceDirectory, file), scale: "device" }); report.screenshots.push(file);
  }
  async function readyEditor(id) {
    await page.goto(`${baseURL}/admin/stories?story=${id}`);
    await page.getByTestId("story-editor").waitFor();
    await page.waitForFunction(() => globalThis.document.querySelectorAll('.publication-slot-options input').length === 7
      && !globalThis.document.querySelector('.publication-read-state[role="status"]'));
  }
  async function mutate(story, action, slotId) {
    const response = await api(`/api/admin/stories/${story.id}/${action}`, { method: action === "slot" ? "PUT" : "POST",
      body: { expectedVersion: story.version, ...(action === "slot" ? { slotId } : {}) } });
    assert.equal(response.status, 200); Object.assign(story, response.data.story); return story;
  }
  try {
    if (evidenceDirectory) await mkdir(evidenceDirectory, { recursive: true });
    // The preceding editor suite deliberately revokes this synthetic administrator.
    const grant = (await owner.query('SELECT "userId",version,"revokedAt" FROM "AdminGrant" WHERE id=1')).rows[0];
    if (grant.revokedAt !== null) await restoreAdmin(maintenance, { userId: grant.userId, expectedVersion: grant.version });
    await owner.query('DELETE FROM "AuthRateLimit"; DELETE FROM "RateLimit"');
    page = await makePage({ width: 1536, height: 1024 });
    await page.goto(baseURL); assert.match(await page.title(), /MQ/);
    assert.equal((await api("/api/auth/sign-in/username", { method: "POST", body: admin })).status, 200);
    const oldBindings = (await owner.query("SELECT id,slot_id FROM story WHERE slot_id IN ('star-1','star-2','star-3') ORDER BY slot_id")).rows;
    assert.equal(oldBindings.length, 3);
    const slots = await api("/api/admin/star-slots"); assert.equal(slots.status, 200);
    assert.deepEqual(slots.data.items.map(slot => slot.id), expected);
    assert.deepEqual(slots.data.items.map(slot => slot.sceneKey), expected.map((_, i) => `story-position--${i + 1}`));
    assert.ok(slots.data.items.slice(0, 3).every(slot => slot.story));
    assert.ok(slots.data.items.slice(3).every(slot => slot.story === null));
    report.checks.push("seven slots returned by real administrator API; existing three bindings retained");

    const added = [];
    for (const slotId of expected.slice(3)) {
      stage = `publish ${slotId}`;
      const result = await api("/api/admin/stories", { method: "POST", body: { kind: "STAR", title: `合成验收 · 星位 ${slotId.slice(5)}`,
        content: { version: 1, blocks: [{ type: "paragraph", text: `仅用于七星位扩充验收：${slotId}，非私人故事。` }] } } });
      assert.equal(result.status, 201); const story = result.data.story;
      await readyEditor(story.id);
      assert.equal(await page.getByRole("radio", { name: "星位 1", exact: true }).isDisabled(), true);
      await page.getByRole("radio", { name: `星位 ${slotId.slice(5)}`, exact: true }).check();
      let response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/admin/stories/${story.id}/slot` && r.request().method() === "PUT");
      await page.getByRole("button", { name: "确认星位", exact: true }).click();
      const selected = await response; assert.equal(selected.status(), 200); Object.assign(story, (await selected.json()).story);
      await page.getByRole("button", { name: "发布故事", exact: true }).waitFor();
      response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/admin/stories/${story.id}/publish` && r.request().method() === "POST");
      await page.getByRole("button", { name: "发布故事", exact: true }).click();
      const published = await response; assert.equal(published.status(), 200); Object.assign(story, (await published.json()).story);
      const read = await api(`/api/stories/${story.id}`, { anonymous: true }); assert.equal(read.status, 200);
      assert.equal(read.data.story.title, `合成验收 · 星位 ${slotId.slice(5)}`); added.push({ ...story, slotId, title: read.data.story.title });
    }
    assert.deepEqual((await owner.query("SELECT id,slot_id FROM story WHERE slot_id IN ('star-1','star-2','star-3') ORDER BY slot_id")).rows, oldBindings);
    stage = "occupied slot and withdrawal";
    const rival = await api("/api/admin/stories", { method: "POST", body: { kind: "STAR", title: "合成验收 · 已占星位不能复用",
      content: { version: 1, blocks: [{ type: "paragraph", text: "只用于冲突负控。" }] } } });
    assert.equal(rival.status, 201); const conflictPath = `/api/admin/stories/${rival.data.story.id}/slot`; allowed.add(conflictPath);
    assert.equal((await api(conflictPath, { method: "PUT", body: { expectedVersion: rival.data.story.version, slotId: "star-4" } })).status, 409);
    await mutate(added[0], "withdraw"); const hiddenPath = `/api/stories/${added[0].id}`; allowed.add(hiddenPath);
    assert.equal((await api(hiddenPath, { anonymous: true })).status, 404);
    assert.equal((await api("/api/admin/star-slots")).data.items.find(slot => slot.id === "star-4").story.id, added[0].id);
    await mutate(added[0], "restore"); assert.equal((await api(hiddenPath, { anonymous: true })).status, 200);
    // Fill only this test database's old occupied positions for the all-seven visual fixture.
    for (const binding of oldBindings) {
      const detail = await api(`/api/admin/stories/${binding.id}/draft`); assert.equal(detail.status, 200);
      const story = detail.data.story; if (story.state !== "PUBLISHED") await mutate(story, story.state === "WITHDRAWN" ? "restore" : "publish");
    }
    report.checks.push("star-4 through star-7 selected and published by real editor; duplicate reservation denied; withdrawal retains binding and restoration works");

    for (const [name, viewport, options] of [
      ["desktop", { width: 1536, height: 1024 }, {}],
      ["mobile-390", { width: 390, height: 844 }, { isMobile: true, hasTouch: true }],
      ["mobile-320", { width: 320, height: 568 }, { isMobile: true, hasTouch: true, reducedMotion: "reduce" }],
    ]) {
      stage = `layout ${name}`; const view = await makePage(viewport, options); await view.goto(baseURL);
      await view.waitForFunction(() => globalThis.document.querySelectorAll('.story-entry--star').length === 7);
      await view.evaluate(async () => { await globalThis.document.fonts.ready; await Promise.all([...globalThis.document.images].map(image => image.decode())); });
      assert.equal(await view.locator("nextjs-portal").count(), 0);
      assert.ok(await view.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
      const layout = await view.locator('.story-entry--star').evaluateAll(nodes => nodes.map(node => {
        const r = node.getBoundingClientRect(); return { id: node.dataset.storyId, x: r.x, y: r.y, w: r.width, h: r.height,
          left: parseFloat(globalThis.getComputedStyle(node.parentElement).left) / globalThis.innerWidth, top: parseFloat(globalThis.getComputedStyle(node.parentElement).top) / globalThis.innerHeight };
      }));
      const obstacles = await view.locator('.wordmark, .scene-nav, .account-controls').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x:r.x,y:r.y,w:r.width,h:r.height }; }));
      await screenshot(view, `${name}-seven-stars`);
      const overlap = (a,b) => Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1 && Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>1;
      for (let i=0;i<layout.length;i++) { const star=layout[i]; assert.ok(star.w>=44&&star.h>=44); assert.ok(star.x>=0&&star.y>=0&&star.x+star.w<=viewport.width&&star.y+star.h<=viewport.height);
        assert.ok(!layout.slice(i+1).some(other=>overlap(star,other)), `${name}: stars overlap`);
        assert.ok(!obstacles.some(other=>overlap(star,other)), `${name}: navigation/logo overlap`); }
      for (const story of added) {
        await view.locator(`.story-entry--star[data-story-id="${story.id}"]`).click();
        const letter = view.locator('dialog.letter-dialog[data-phase="reading"]'); await letter.waitFor();
        assert.equal(await letter.getByRole("heading", { level: 2 }).innerText(), story.title);
        await view.getByRole("button", { name: "关闭羽毛信", exact: true }).click(); await letter.waitFor({ state: "detached" });
      }
      await page.setViewportSize(viewport); await readyEditor(added[0].id);
      assert.equal(await page.locator('.publication-map-point').count(),7);
      const map = await page.locator('.publication-map-point').evaluateAll(nodes => nodes.map(node => {
        const style=globalThis.getComputedStyle(node), parent=node.parentElement; return { number:Number(node.querySelector('small').textContent),
          left:parseFloat(style.left)/parent.clientWidth,top:parseFloat(style.top)/parent.clientHeight };
      }));
      const catalog = (await api('/api/stories',{anonymous:true})).data.stories;
      for (const point of map) { const story=catalog.find(s=>s.slotId===`star-${point.number}`), actual=layout.find(p=>p.id===story.id);
        assert.ok(Math.abs(point.left-actual.left)<0.005&&Math.abs(point.top-actual.top)<0.005, `${name}: administrator/home positions differ`); }
      await page.locator('.publication-slots').scrollIntoViewIfNeeded(); await screenshot(page, `${name}-seven-slot-management`);
      report.views.push({ name, viewport, deviceScaleFactor:2, positions:map });
    }
    const rows = (await owner.query('SELECT email AS value FROM "User" UNION ALL SELECT token AS value FROM "Session" UNION ALL SELECT "tokenCiphertext" AS value FROM "Session" UNION ALL SELECT password AS value FROM "Account" WHERE password IS NOT NULL')).rows;
    rows.forEach(row=>privateValues.add(row.value));
    report.checks.push("desktop/390/320 seven visible targets, no overlap or overflow, matching administrator map and four working new reader entries");
    assert.deepEqual(failures, []); report.passed=true;
  } catch(error) {
    const safe=new Error("SEVEN_STAR_BROWSER_FAILED"); safe.publishingStage=`seven stars: ${stage}`;
    const location=/star-slots-browser-tests\.mjs:(\d+):(\d+)/.exec(error?.stack??"");
    if(location)safe.publishingStage+=` [line ${location[1]}:${location[2]}]`;
    safe.code=error?.name==="TimeoutError"?"TIMEOUT":error?.code==="ERR_ASSERTION"?"ERR_ASSERTION":"ERROR";
    if (typeof error?.actual === "number" && typeof error?.expected === "number") safe.publishingStage+=` [actual=${error.actual}, expected=${error.expected}]`;
    throw safe;
  } finally {
    await Promise.allSettled(contexts.map(context=>context.close())); await browser.close();
    await Promise.allSettled([owner.end(),maintenance.$disconnect()]);
    if(evidenceDirectory)await writeFile(resolve(evidenceDirectory,"seven-star-browser-report.json"),JSON.stringify(report,null,2));
  }
  return report;
}
