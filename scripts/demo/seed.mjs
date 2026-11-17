import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { demoStories } from "../../src/data/demo-stories.ts";
import { demoRequest } from "./http.mjs";
import { demoOrigin } from "./config.mjs";

let stage = "configuration";
try {
  if ((await readdir("/run/mq-demo/setup")).includes("seeded.json")) {
    console.log("DEMO_EXISTING_CONTENT_PRESERVED");
  } else {
    const state = JSON.parse(await readFile("/run/mq-demo/setup/config.json", "utf8"));
    const secrets = JSON.parse(await readFile("/run/mq-demo/setup/credentials.json", "utf8"));
    const request = demoRequest("http://app:3000", demoOrigin(state)), admin = {}, reader = {};
    stage = "admin-login";
    assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: secrets.admin, jar: admin })).status, 200);
    const catalog = await request("/api/admin/stories", { jar: admin });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.data.items.length, 0, "DEMO_PARTIAL_SEED_REQUIRES_REVIEW: existing stories will not be replaced");
    stage = "reader-signup";
    assert.equal((await request("/api/auth/sign-up/email", { method: "POST", body: secrets.reader, jar: reader })).status, 200);
    const ids = [];
    for (const [index, fixture] of demoStories.entries()) {
      stage = `image-${index + 1}`;
      const uploaded = await request("/api/admin/media", { method: "POST", jar: admin,
        headers: { "content-type": "image/webp", "idempotency-key": randomUUID() }, bytes: await readFile(`/app/public${fixture.image.src}`) });
      assert.equal(uploaded.status, 201);
      const content = { version: 2, blocks: [{ type: "paragraph", text: fixture.introduction },
        ...fixture.paragraphs.map(text => ({ type: "paragraph", text })),
        { type: "image", assetId: uploaded.data.asset.id, alt: fixture.image.alt, caption: fixture.image.caption },
        { type: "paragraph", text: fixture.closing }] };
      stage = `story-${index + 1}`;
      const created = await request("/api/admin/stories", { method: "POST", jar: admin,
        body: { kind: index === 3 ? "CAMPFIRE" : "STAR", title: `[本地演示] ${fixture.title}`, content } });
      assert.equal(created.status, 201); let story = created.data.story;
      if (index < 3) {
        stage = `slot-${index + 1}`;
        const bound = await request(`/api/admin/stories/${story.id}/slot`, { method: "PUT", jar: admin,
          body: { expectedVersion: story.version, slotId: `star-${index + 1}` } });
        assert.equal(bound.status, 200); story = bound.data.story;
      }
      stage = `publication-${index + 1}`;
      const published = await request(`/api/admin/stories/${story.id}/publish`, { method: "POST", jar: admin, body: { expectedVersion: story.version } });
      assert.equal(published.status, 200); ids.push(story.id);
    }
    await writeFile("/run/mq-demo/setup/seeded.json", JSON.stringify({ stories: ids }), { flag: "wx", mode: 0o600 });
    await request("/api/auth/sign-out", { method: "POST", jar: admin, body: {} });
    await request("/api/auth/sign-out", { method: "POST", jar: reader, body: {} });
    console.log("DEMO_SEEDED: four synthetic stories, private images, one admin and one ordinary reader");
  }
} catch { console.error(`DEMO_SEED_FAILED: ${stage}; partial content retained; no fixtures overwrite or silent fallback`); process.exitCode = 1; }
