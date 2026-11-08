import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "./database-config.mjs";
import { laboratoryTransport } from "./http-tests.mjs";
import { waitForHttpsReady } from "./vps-maintenance.mjs";

/** Real disaster-recovery fixture: another PostgreSQL cluster may legitimately
 * use the same mq_production name, but never the source deployment/volume. */
export async function runProductionRecovery(ctx, fixture) {
  const { docker, compose, project, manifest, directory, evidence, images, volume, volumes, secret, files, envFile, overrideFile, transportFile, root, secrets } = ctx;
  const id = randomUUID(), targetProject = `${project}-restore`, started = Date.now();
  const target = { ...manifest, deploymentId: id }, config = validateDeploymentConfig(target);
  const passwords = Object.fromEntries(LOGIN_IDENTITIES.map(name => [name, secret()])), bootstrapPassword = secret();
  const url = identity => `postgresql://${identity === "bootstrap" ? "mq_bootstrap" : config.roles[identity]}:${identity === "bootstrap" ? bootstrapPassword : passwords[identity]}@postgres:5432/mq_production`;
  const app = { database_url: url("runtime"), auth_secret: secret(), session_storage_key: secret(), auth_proxy_secret: secret(), publish_signing_key: secret(), comment_signing_key: secret() };
  Object.values(app).forEach(value => secrets.add(value));
  await volume("restore-manifest", { "deployment.json": JSON.stringify(target) });
  await volume("restore-pg", { postgres_password: bootstrapPassword }, 999);
  await volume("restore-app", app); await volume("restore-proxy", { auth_proxy_secret: app.auth_proxy_secret });
  await volume("restore-credentials", { bootstrap_database_url: url("bootstrap"), migration_database_url: url("migration"), database_url: url("runtime"),
    role_passwords: JSON.stringify(passwords), restic_password: files.restic_password });
  const override = join(directory, "restore.yaml");
  await writeFile(override, `services:
  app:
    environment:
      MQ_AUTH_ENABLED: "true"
      MQ_MEDIA_ENABLED: "true"
      MQ_PUBLISH_ENABLED: "false"
      MQ_COMMENTS_ENABLED: "false"
  tools:
    environment:
      MQ_SYNTHETIC_DEPLOYMENT_ID: ${id}
volumes:
${["manifest", "pg", "app", "proxy"].map(name => `  ${name}: { external: true, name: ${volumes[`restore-${name}`]} }`).join("\n")}
`);
  const base = ["compose", "--project-name", targetProject, "--env-file", envFile, "-f", join(root, "compose.production.yaml"), "-f", overrideFile, "-f", override];
  const targetCompose = (args, options) => docker([...base, ...args], options);
  const transport = args => docker([...base, "-f", transportFile, ...args]);
  const service = name => targetCompose(["ps", "-q", name]).stdout.trim();
  const operation = name => targetCompose(["run", "--rm", "--no-deps", "-v", `${volumes["restore-credentials"]}:/run/secrets:ro`,
    "-e", "BOOTSTRAP_DATABASE_URL_FILE=/run/secrets/bootstrap_database_url", "-e", "MQ_ROLE_PASSWORDS_FILE=/run/secrets/role_passwords",
    "-e", "RUNTIME_DATABASE_URL_FILE=/run/secrets/database_url", "tools", "scripts/production/database-cli.mjs", name,
    ...(name === "audit" ? [] : [`--confirm-production=${id}`])]);
  const restoreArgs = ["run", "--rm", "--read-only", "--memory", "512m", "--cpus", "1", "--network", `${targetProject}_database`,
    "--mount", `type=volume,source=${volumes["restore-manifest"]},target=/etc/mq,readonly`,
    "--mount", `type=volume,source=${volumes["restore-credentials"]},target=/run/secrets,readonly`,
    "--mount", `type=volume,source=${volumes.operations},target=/var/lib/mq/operations`,
    "--mount", `type=volume,source=${targetProject}_media,target=/var/lib/mq/media`,
    "--tmpfs", "/tmp:rw,nosuid,size=64m,uid=10001,gid=10001,mode=0700"];
  for (const [key, value] of Object.entries({ MQ_SYNTHETIC_LAB: "true", MQ_SYNTHETIC_DEPLOYMENT_ID: id, MQ_DEPLOYMENT_CONFIG: "/etc/mq/deployment.json",
    BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url", MIGRATION_DATABASE_URL_FILE: "/run/secrets/migration_database_url",
    RESTIC_PASSWORD_FILE: "/run/secrets/restic_password", MQ_BACKUP_SNAPSHOT_ID: fixture.backupReceipt.snapshotId })) restoreArgs.push("-e", `${key}=${value}`);
  let succeeded = false, stage = "target-database-start", browserObservation;
  compose(["stop", "postgres"]); // Keep one database/app pair active on small hosts.
  try {
    targetCompose(["up", "-d", "--wait", "--wait-timeout", "180", "postgres"]);
    stage = "target-restore-and-permission-audit";
    operation("bootstrap"); targetCompose(["run", "--rm", "--no-deps", "volumes-init"]);
    const restore = action => [...restoreArgs, images.operations, "tests/fixtures/production-bootstrap-actions.mjs", action];
    docker(restore("restore"));
    assert.equal(docker(restore("restore"), { fail: false }).status, 1);
    operation("provision"); operation("audit"); docker(restore("restored"));
    stage = "restored-app-and-proxy-start";
    transport(["up", "-d", "--wait", "--wait-timeout", "180", "app", "proxy"]);
    let ca;
    for (let i = 0; i < 60; i++) {
      const probe = docker(["exec", service("proxy"), "cat", "/data/caddy/pki/authorities/local/root.crt"], { fail: false });
      if (probe.status === 0 && probe.stdout.includes("BEGIN CERTIFICATE")) { ca = probe.stdout; break; }
      await delay(500);
    }
    assert.ok(ca);
    // The root CA exists before Caddy necessarily accepts TLS connections.
    // Wait for a verified public read, without retrying any mutation below.
    stage = "restored-https-readiness";
    await waitForHttpsReady(manifest.origin, ca, { onFailure: observation => {
      console.log(`PRODUCTION_RECOVERY_NOT_READY=${JSON.stringify(observation)}`);
    } });
    stage = "restored-https-permissions";
    const request = laboratoryTransport(manifest.origin, ca, secrets);
    assert.equal((await request("/api/admin/stories", { jar: fixture.oldJar })).status, 401);
    assert.equal((await request(`/api/stories/${fixture.privateStoryId}`)).status, 404);
    const detail = await request(`/api/stories/${fixture.storyId}`); assert.equal(detail.status, 200);
    assert.equal((await request(`/api/stories/${fixture.storyId}/comments`)).data.count, 1);
    for (const method of ["GET", "HEAD"]) {
      assert.equal((await request(`/api/stories/${fixture.storyId}/media/${fixture.assetId}`, { method })).status, 200);
      assert.equal((await request(`/api/stories/${fixture.storyId}/media/${fixture.privateAssetId}`, { method })).status, 404);
      assert.equal((await request(`/api/admin/media/${fixture.privateAssetId}/content`, { method })).status, 401);
    }
    const content = await request(`/api/stories/${fixture.storyId}/media/${fixture.assetId}`);
    assert.equal(createHash("sha256").update(content.bytes).digest("hex"), fixture.imageHash);
    const adminJar = {};
    assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: fixture.admin, jar: adminJar })).status, 200);
    assert.equal((await request(`/api/admin/media/${fixture.privateAssetId}/content`, { jar: adminJar })).status, 200);
    assert.equal((await request(`/api/admin/stories/${fixture.storyId}/withdraw`, { method: "POST", jar: adminJar,
      body: { expectedVersion: detail.data.story.version ?? 0 } })).status, 503);
    stage = "restored-browser-launch";
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
        isMobile: true, reducedMotion: "reduce", ignoreHTTPSErrors: true });
      const page = await context.newPage();
      browserObservation = { documentStatus: null, domReady: false, loadComplete: false, failedResources: {} };
      page.on("domcontentloaded", () => { browserObservation.domReady = true; });
      page.on("load", () => { browserObservation.loadComplete = true; });
      page.on("response", response => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) browserObservation.documentStatus = response.status();
      });
      page.on("requestfailed", request => {
        const type = ["document", "script", "stylesheet", "image", "font", "fetch", "xhr"].includes(request.resourceType())
          ? request.resourceType() : "other";
        browserObservation.failedResources[type] = (browserObservation.failedResources[type] ?? 0) + 1;
      });
      stage = "restored-browser-navigation";
      // A recovery check waits for the application and decoded story image
      // below, not the load event of every background scene resource.
      assert.equal((await page.goto(`${manifest.origin}/stories/${detail.data.story.slug}`, { waitUntil: "domcontentloaded" })).status(), 200);
      stage = "restored-browser-reader";
      await page.locator('dialog[data-phase="reading"]').waitFor();
      stage = "restored-browser-image-load";
      const image = page.getByRole("img", { name: "合成蓝灰色图片", exact: true });
      await image.scrollIntoViewIfNeeded();
      await page.waitForFunction(element => element.complete && element.naturalWidth > 0,
        await image.elementHandle(), { timeout: 20000 });
      stage = "restored-browser-image-decode";
      await image.evaluate(element => element.decode());
      stage = "restored-browser-screenshot";
      await page.screenshot({ path: join(evidence, "production-restored-mobile.png"), scale: "device" });
      await context.close();
    } finally { await browser.close(); }
    const result = { restored: true, sourceDatabase: "mq_production", targetDatabase: "mq_production", distinctClusters: true,
      distinctDeploymentIds: true, sessionsCleared: true, businessKeysCleared: true, publicAndPrivateMediaVerified: true,
      elapsedMs: Date.now() - started, productionDeployed: false, browser: browserObservation };
    await writeFile(join(evidence, "production-recovery.json"), JSON.stringify(result, null, 2));
    succeeded = true; return result;
  } catch (error) {
    if (browserObservation) console.error(`PRODUCTION_RECOVERY_BROWSER=${JSON.stringify(browserObservation)}`);
    const known = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "ERR_ASSERTION"];
    console.error(`PRODUCTION_RECOVERY_FAILED stage=${stage};code=${known.includes(error?.code) ? error.code
      : error?.name === "TimeoutError" ? "BROWSER_TIMEOUT" : "REJECTED"}`);
    throw error;
  } finally {
    targetCompose(["down", "--remove-orphans"], { fail: false });
    if (succeeded) for (const name of docker(["volume", "ls", "--filter", `name=${targetProject}`, "--format", "{{.Name}}"] ).stdout.trim().split(/\r?\n/).filter(Boolean)) {
      assert.ok(name.startsWith(`${targetProject}_`)); docker(["volume", "rm", name]);
    }
    // Do not revive an uncertain source after failed recovery. Its known data
    // volume remains intact for diagnosis; successful recovery resumes its PG.
    if (succeeded) compose(["up", "-d", "--wait", "--wait-timeout", "180", "postgres"]);
  }
}
