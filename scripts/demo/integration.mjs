import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright";
import { startDemo, command } from "./cli.mjs";
import { demoOrigin, projectName } from "./config.mjs";
import { demoRequest } from "./http.mjs";

// This test alone owns its random state/project. Manual demo never runs down -v.
const directory = await mkdtemp(join(tmpdir(), "mq-demo-integration-"));
const statePath = join(directory, "state.json");
const evidence = resolve(process.env.MQ_DEMO_EVIDENCE_DIR ?? join(directory, "evidence"));
await mkdir(evidence, { recursive: true });
const port = await new Promise(resolve => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); }); });
let demo, stage = "start", passed = false;
const checks = [];
async function check(name, action) { stage = name; await action(); checks.push(name); console.log(`PASS demo: ${name}`); }
try {
  demo = await startDemo({ statePath, port });
  const { state, compose } = demo, origin = demoOrigin(state), request = demoRequest(origin), admin = {}, reader = {};
  const accounts = JSON.parse(await compose(["run", "--rm", "--no-deps", "initialize", "scripts/demo/credentials.mjs"], { capture: true }));
  let stories, first, image, imageHash, draft;
  await check("real seeded catalog, accounts, seven slots and authorization", async () => {
    const catalog = await request("/api/stories"); assert.equal(catalog.status, 200); stories = catalog.data.stories;
    assert.equal(stories.length, 4); assert.equal(stories.filter(story => story.entry === "star").length, 3);
    assert.equal(stories.filter(story => story.entry === "campfire").length, 1);
    assert.ok(stories.every(story => story.title.startsWith("[本地演示]")));
    assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: accounts.admin, jar: admin })).status, 200);
    assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: accounts.reader, jar: reader })).status, 200);
    assert.equal((await request("/api/admin/stories", { jar: reader })).status, 403);
    assert.equal((await request("/api/admin/stories")).status, 401);
    assert.equal((await request("/api/admin/star-slots", { jar: admin })).data.items.length, 7);
    assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: accounts.admin, requestOrigin: "https://outside.invalid" })).status, 403);
    first = stories.find(story => story.entry === "star");
    const detail = (await request(`/api/stories/${first.id}`)).data.story;
    image = detail.content.blocks.find(block => block.type === "image"); assert.ok(image?.assetId);
    const response = await request(`/api/stories/${first.id}/media/${image.assetId}`); assert.equal(response.status, 200);
    imageHash = createHash("sha256").update(response.bytes).digest("hex");
  });
  await check("only loopback HTTP is published; secrets absent from Docker configuration", async () => {
    const ids = (await compose(["ps", "-q"], { capture: true })).trim().split(/\s+/);
    const containers = JSON.parse(await command(["inspect", ...ids], { capture: true }));
    for (const container of containers) {
      assert.equal(container.Config.Labels["com.docker.compose.project"], projectName(state));
      assert.ok(container.Config.Env.every(value => !/^(?:DATABASE_URL|AUTH_SECRET|SESSION_STORAGE_KEY|MQ_PUBLISH_SIGNING_KEY|MQ_COMMENT_SIGNING_KEY)=/.test(value)));
      const mappings = Object.values(container.HostConfig.PortBindings ?? {}).flat();
      if (container.Config.Labels["com.docker.compose.service"] === "app") assert.deepEqual(mappings, [{ HostIp: "127.0.0.1", HostPort: String(port) }]);
      else assert.equal(mappings.length, 0);
    }
  });
  await check("real editor writes and unpublished content remains private", async () => {
    const response = await request("/api/admin/stories", { method: "POST", jar: admin,
      body: { kind: "STAR", title: "本地修改：再次启动不覆盖", content: { version: 1, blocks: [{ type: "paragraph", text: "integration-owned draft" }] } } });
    assert.equal(response.status, 201); draft = response.data.story;
    assert.equal((await request(`/api/stories/${draft.id}`)).status, 404);
    assert.equal((await request(`/api/admin/stories/${draft.id}/draft`, { jar: reader })).status, 403);
  });
  await check("stop/start retains database, images, sessions and edited content without reseeding", async () => {
    const beforeState = await readFile(statePath, "utf8");
    const beforeVolumes = (await command(["volume", "ls", "--filter", `label=com.docker.compose.project=${projectName(state)}`, "--format", "{{.Name}}"], { capture: true })).trim().split(/\s+/).sort();
    assert.equal(beforeVolumes.length, 5);
    await compose(["stop", "app", "postgres"]);
    demo = await startDemo({ statePath, port });
    assert.equal(await readFile(statePath, "utf8"), beforeState);
    assert.deepEqual((await request("/api/stories")).data.stories, stories);
    assert.equal((await request(`/api/admin/stories/${draft.id}/draft`, { jar: admin })).data.draft.title, "本地修改：再次启动不覆盖");
    assert.equal(createHash("sha256").update((await request(`/api/stories/${first.id}/media/${image.assetId}`)).bytes).digest("hex"), imageHash);
    assert.deepEqual((await command(["volume", "ls", "--filter", `label=com.docker.compose.project=${projectName(state)}`, "--format", "{{.Name}}"], { capture: true })).trim().split(/\s+/).sort(), beforeVolumes);
    assert.equal((await request("/api/auth/sign-out", { method: "POST", jar: reader, body: {} })).status, 200);
    assert.equal((await request("/api/admin/stories", { jar: reader })).status, 401);
  });
  await check("desktop/mobile browser scene, real reading and admin workspace", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const [name, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
        const context = await browser.newContext({ viewport, reducedMotion: "reduce", ...(name === "mobile" ? { isMobile: true, hasTouch: true } : {}) });
        const page = await context.newPage(), errors = [];
        page.on("pageerror", () => errors.push("runtime"));
        assert.equal((await page.goto(origin)).status(), 200);
        await page.locator(".account-controls").waitFor();
        const star = page.locator(`.story-entry[data-story-id="${first.id}"]`);
        await star.waitFor();
        await page.evaluate(() => Promise.all([...globalThis.document.images].map(image => image.decode())));
        await page.screenshot({ path: join(evidence, `demo-${name}.png`) });
        await star.click();
        await page.locator('dialog[data-phase="reading"]').waitFor({ timeout: 20000 });
        await page.getByRole("heading", { name: first.title, exact: true }).waitFor();
        const displayedImage = page.getByRole("img", { name: image.alt, exact: true });
        await displayedImage.waitFor(); await displayedImage.evaluate(element => element.decode());
        assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false);
        await page.screenshot({ path: join(evidence, `demo-reader-${name}.png`) });
        assert.equal((await page.goto(`${origin}/stories/${first.slug}`)).status(), 200);
        await page.getByRole("heading", { name: first.title, exact: true }).waitFor();
        await page.goto(origin);
        await page.locator(".account-controls").getByRole("button", { name: "登录", exact: true }).click();
        const dialog = page.locator(".auth-dialog");
        await dialog.getByLabel("用户名", { exact: true }).fill(accounts.admin.username);
        await dialog.getByLabel("密码", { exact: true }).fill(accounts.admin.password);
        await dialog.locator(".auth-submit").click(); await dialog.waitFor({ state: "detached" });
        await page.goto(`${origin}/admin/stories?story=${first.id}`); await page.getByTestId("story-editor").waitFor();
        assert.equal(await page.getByLabel("故事标题", { exact: true }).inputValue(), first.title);
        await page.screenshot({ path: join(evidence, `demo-admin-${name}.png`) });
        assert.equal(errors.length, 0); await context.close();
      }
    } finally { await browser.close(); }
  });
  passed = true;
} catch { console.error(`DEMO_INTEGRATION_FAILED: ${stage}; raw responses and credentials withheld`); process.exitCode = 1; }
finally {
  await writeFile(join(evidence, "summary.json"), JSON.stringify({ passed, checks, ...(passed ? {} : { failedStage: stage }), syntheticOnly: true }, null, 2));
  if (passed && demo) await demo.compose(["down", "--volumes", "--remove-orphans"]);
  else console.error(`DEMO_TEST_STATE_RETAINED: ${statePath}; inspect this test's project before retrying`);
  // No host files, developer databases or non-test Docker resources are removed.
}
