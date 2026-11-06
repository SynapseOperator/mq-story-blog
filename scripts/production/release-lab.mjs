import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planRelease, applySyntheticRelease } from "../release/deploy.mjs";
import { releaseCompatibility, TARGETS } from "../release/bundle.mjs";

/** Exercise failure containment and application-only rollback against the real
 * restored/rotated lab. The broken image is deliberate and never exported. */
export async function runReleaseLab(ctx, { request, story, asset, privateAsset, oldJar, currentJar, receipt, databaseOperation }) {
  const { docker, compose, composeBase, project, directory, manifest, images, revision } = ctx;
  const serviceId = service => compose(["ps", "-a", "-q", service]).stdout.trim();
  const indexDigest = image => {
    const refs = JSON.parse(docker(["image", "inspect", image, "--format", "{{json .RepoDigests}}"] ).stdout);
    assert.ok(refs.length > 0, "RELEASE_LAB_OCI_DIGEST_MISSING");
    return refs[0].split("@")[1];
  };
  const current = { version: 1, platform: "linux/amd64", sourceSha: revision,
    compatibility: await releaseCompatibility(process.cwd()),
    images: Object.fromEntries(TARGETS.map(name => [name, { indexDigest: indexDigest(images[name]) }])) };
  const faultImage = `${project}-fault:local`;
  const override = join(directory, "release-app.yaml");
  let healthy = false;
  try {
    docker(["build", "--network", "none", "-t", faultImage, "-"], { input:
      `FROM ${images.app}\nLABEL mq.synthetic.release-fault="true"\nCMD ["node","-e","process.exit(1)"]\n` });
    const rejected = { ...current, images: { ...current.images, app: { indexDigest: indexDigest(faultImage) } } };
    const upgrade = planRelease({ release: rejected, currentRelease: current, config: manifest, backupReceipt: receipt });
    const rollback = planRelease({ release: current, currentRelease: rejected, config: manifest, backupReceipt: receipt, mode: "rollback" });
    const execute = async (step, plan) => {
      if (step === "close-ingress") compose(["stop", "proxy"]);
      else if (step === "stop-app") compose(["stop", "app"]);
      else if (["migrate", "provision", "audit"].includes(step)) databaseOperation(step);
      else if (step === "start-app") {
        await writeFile(override, `services:\n  app:\n    image: ${plan.images.app}\n`);
        docker([...composeBase, "-f", override, "up", "-d", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "45", "app"], { timeout: 90000 });
      } else if (step === "health") {
        return docker(["inspect", serviceId("app"), "--format", "{{.State.Health.Status}}"] ).stdout.trim() === "healthy";
      } else if (step === "open-ingress") compose(["up", "-d", "--no-deps", "--wait", "--wait-timeout", "90", "proxy"]);
      else assert.fail("Unknown release step");
    };
    await assert.rejects(applySyntheticRelease({ plan: upgrade, confirmation: manifest.deploymentId, execute }), /RELEASE_FAILED_INGRESS_CLOSED/);
    for (const name of ["app", "proxy"]) assert.equal(docker(["inspect", serviceId(name), "--format", "{{.State.Running}}"] ).stdout.trim(), "false");
    await assert.rejects(request("/api/stories"));
    await applySyntheticRelease({ plan: rollback, confirmation: manifest.deploymentId, execute });
    assert.equal((await request(`/api/stories/${story.id}`)).data.story.title, story.draftTitle);
    assert.equal((await request("/api/admin/stories", { jar: oldJar })).status, 401);
    assert.equal((await request("/api/admin/stories", { jar: currentJar })).status, 200);
    assert.equal((await request(`/api/stories/${story.id}/comments`)).data.count, 2);
    assert.equal((await request(`/api/stories/${story.id}/likes`)).data.count, 1);
    for (const method of ["GET", "HEAD"]) {
      assert.equal((await request(`/api/stories/${story.id}/media/${asset.id}`, { method })).status, 200);
      assert.equal((await request(`/api/stories/${story.id}/media/${privateAsset.id}`, { method })).status, 404);
    }
    const restored = await request(`/api/stories/${story.id}/media/${asset.id}`);
    assert.equal(createHash("sha256").update(restored.bytes).digest("hex"), asset.display.sha256);
    healthy = true;
    console.log("PASS release: failed image closes ingress; explicit compatible image rollback retains database and secrets");
    compose(["stop", "postgres"]);
    assert.equal((await request("/api/stories")).status, 503);
    compose(["up", "-d", "--wait", "--wait-timeout", "90", "postgres"]);
    assert.equal((await request(`/api/stories/${story.id}`)).status, 200);
    console.log("PASS release: database outage denies requests and recovery preserves published story");
    return { failedImageContained: true, applicationRollback: true, databaseRollback: false, databaseOutage: true };
  } finally {
    // Only the exact fault tag created here; no daemon-wide image cleanup.
    if (healthy) docker(["image", "rm", faultImage], { fail: false });
  }
}
