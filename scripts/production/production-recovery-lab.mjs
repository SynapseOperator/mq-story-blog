import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
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
  let succeeded = false, stage = "restored-browser-prepare", browserObservation, browser;
  try {
    // Initialize the empty browser before changing Docker interfaces, rather
    // than interleaving Chromium's initial network observation with navigation.
    browser = await chromium.launch({ args: ["--host-resolver-rules=MAP mq.localhost 127.0.0.1"] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
      isMobile: true, reducedMotion: "reduce", ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto("about:blank");
    stage = "target-database-start";
    compose(["stop", "postgres"]); // Keep one database/app pair active on small hosts.
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
    stage = "restored-https-share-html";
    const sharePath = `/stories/${detail.data.story.slug}`;
    const share = await request(sharePath);
    assert.equal(share.status, 200);
    assert.ok(share.text.includes(detail.data.story.title) && share.text.includes("</html>"));
    const storyPath = `/api/stories/by-slug/${encodeURIComponent(detail.data.story.slug)}`;
    const bySlug = await request(storyPath);
    assert.equal(bySlug.status, 200);
    assert.equal(bySlug.data.story.id, fixture.storyId);
    {
      browserObservation = { documentStatus: null, domReady: false, loadComplete: false, failedResources: {}, resourceFailures: [], httpErrors: [], documentFailures: [], navigationAttempts: [], storyRequests: [], storyState: "loading" };
      let navigationRequest, navigationFailure, storyRequest, storyObservation;
      page.on("request", request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigationRequest = request;
        const url = new URL(request.url());
        if (request.method() === "GET" && url.origin === manifest.origin && url.pathname === storyPath) {
          storyRequest = request; storyObservation = { status: null, code: null, finished: false };
          browserObservation.storyRequests.push(storyObservation);
        }
      });
      page.on("domcontentloaded", () => { browserObservation.domReady = true; });
      page.on("load", () => { browserObservation.loadComplete = true; });
      page.on("response", response => {
        if (response.request() === navigationRequest) browserObservation.documentStatus = response.status();
        if (response.request() === storyRequest) storyObservation.status = response.status();
        if (response.status() >= 400) browserObservation.httpErrors.push({ type: response.request().resourceType(), status: response.status() });
      });
      page.on("requestfinished", request => { if (request === storyRequest) storyObservation.finished = true; });
      page.on("requestfailed", request => {
        const type = ["document", "script", "stylesheet", "image", "font", "fetch", "xhr"].includes(request.resourceType())
          ? request.resourceType() : "other";
        browserObservation.failedResources[type] = (browserObservation.failedResources[type] ?? 0) + 1;
        const reported = request.failure()?.errorText;
        const code = /^net::ERR_[A-Z0-9_]+$/.test(reported ?? "") ? reported : "UNCLASSIFIED_NETWORK_FAILURE";
        browserObservation.resourceFailures.push({ type, code });
        if (request === navigationRequest) {
          navigationFailure = code;
          browserObservation.documentFailures.push(navigationFailure);
        }
        if (request === storyRequest) storyObservation.code = code;
      });
      stage = "restored-browser-navigation";
      // A recovery check waits for the application and decoded story image
      // below, not the load event of every background scene resource.
      let response;
      for (let attempt = 1; attempt <= 3; attempt++) {
        navigationRequest = undefined; navigationFailure = undefined;
        browserObservation.documentStatus = null; browserObservation.domReady = false; browserObservation.loadComplete = false;
        try {
          response = await page.goto(`${manifest.origin}${sharePath}`, { waitUntil: "domcontentloaded" });
          browserObservation.navigationAttempts.push({ attempt, status: response.status(), domReady: browserObservation.domReady, code: navigationFailure ?? null });
          break;
        } catch (error) {
          // Linux Chromium may observe delayed Docker interface changes after
          // the restored stack becomes healthy. A header is not a complete
          // document: retry this public GET only after its own network failure,
          // never an ordinary timeout/HTTP error, completed DOM or any write.
          browserObservation.navigationAttempts.push({ attempt, status: browserObservation.documentStatus,
            domReady: browserObservation.domReady, code: navigationFailure ?? null });
          if (attempt === 3 || browserObservation.domReady || navigationFailure !== "net::ERR_NETWORK_CHANGED"
            || ![null, 200].includes(browserObservation.documentStatus)) throw error;
          console.log(`PRODUCTION_RECOVERY_NETWORK_CHANGED retry=${attempt}`);
          await delay(500);
        }
      }
      assert.equal(response.status(), 200);
      assert.equal(browserObservation.domReady, true);
      stage = "restored-browser-reader";
      await page.locator('dialog[data-phase="reading"]').waitFor();
      stage = "restored-browser-story-content";
      for (let attempt = 1; attempt <= 3; attempt++) {
        await page.waitForFunction(() => globalThis.document.querySelector('dialog .letter-prose')
          || globalThis.document.querySelector('dialog .letter-load-state[data-state="error"], dialog .letter-load-state[data-state="not-found"]'));
        const state = page.locator("dialog .letter-load-state");
        browserObservation.storyState = await state.count() ? await state.getAttribute("data-state") : "ready";
        if (browserObservation.storyState === "ready") break;
        // Exercise the reader's real retry UI only for this public GET's
        // confirmed network interruption. HTTP/schema/auth failures stay red.
        assert.equal(browserObservation.storyState, "error");
        assert.equal(storyObservation?.code, "net::ERR_NETWORK_CHANGED");
        assert.ok([null, 200].includes(storyObservation.status) && attempt < 3);
        console.log(`PRODUCTION_RECOVERY_STORY_NETWORK_CHANGED retry=${attempt}`);
        await delay(500);
        const previousRequest = storyRequest;
        const [nextRequest] = await Promise.all([
          page.waitForRequest(request => {
            const url = new URL(request.url());
            return request !== previousRequest && request.method() === "GET" && url.origin === manifest.origin && url.pathname === storyPath;
          }),
          page.getByRole("button", { name: "重试加载故事", exact: true }).click(),
        ]);
        assert.equal(nextRequest, storyRequest);
      }
      assert.equal(browserObservation.storyState, "ready");
      assert.equal(storyObservation?.status, 200);
      assert.equal(storyObservation?.finished, true);
      stage = "restored-browser-image-load";
      const image = page.getByRole("img", { name: "合成蓝灰色图片", exact: true });
      await image.scrollIntoViewIfNeeded();
      await page.waitForFunction(element => element.complete && element.naturalWidth > 0,
        await image.elementHandle(), { timeout: 20000 });
      stage = "restored-browser-image-decode";
      await image.evaluate(element => element.decode());
      stage = "restored-browser-screenshot";
      await page.screenshot({ path: join(evidence, "production-restored-mobile.png"), scale: "device" });
    }
    const result = { restored: true, sourceDatabase: "mq_production", targetDatabase: "mq_production", distinctClusters: true,
      distinctDeploymentIds: true, sessionsCleared: true, businessKeysCleared: true, publicAndPrivateMediaVerified: true,
      elapsedMs: Date.now() - started, productionDeployed: false, browser: globalThis.structuredClone(browserObservation) };
    await writeFile(join(evidence, "production-recovery.json"), JSON.stringify(result, null, 2));
    succeeded = true; return result;
  } catch (error) {
    if (browserObservation) console.error(`PRODUCTION_RECOVERY_BROWSER=${JSON.stringify(browserObservation)}`);
    if (stage.startsWith("restored-browser")) {
      for (const name of ["app", "proxy"]) {
        const id = service(name);
        const probe = id && docker(["inspect", id, "--format", "{{json .State}}"], { fail: false });
        if (probe?.status === 0) {
          const state = JSON.parse(probe.stdout);
          console.error(`PRODUCTION_RECOVERY_SERVICE=${JSON.stringify({ service: name, running: state.Running,
            oom: state.OOMKilled, exitCode: state.ExitCode, health: state.Health?.Status ?? "none" })}`);
        }
      }
    }
    const known = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "ERR_ASSERTION"];
    console.error(`PRODUCTION_RECOVERY_FAILED stage=${stage};code=${known.includes(error?.code) ? error.code
      : error?.name === "TimeoutError" ? "BROWSER_TIMEOUT" : "REJECTED"}`);
    throw error;
  } finally {
    // Failure observations above are serialized before close can abort pending
    // resources, so cleanup cancellations cannot be mistaken for the cause.
    try { await browser?.close(); } finally {
      targetCompose(["down", "--remove-orphans"], { fail: false });
      if (succeeded) for (const name of docker(["volume", "ls", "--filter", `name=${targetProject}`, "--format", "{{.Name}}"] ).stdout.trim().split(/\r?\n/).filter(Boolean)) {
        assert.ok(name.startsWith(`${targetProject}_`)); docker(["volume", "rm", name]);
      }
      // Do not revive an uncertain source after failed recovery. Its known data
      // volume remains intact for diagnosis; successful recovery resumes its PG.
      if (succeeded) compose(["up", "-d", "--wait", "--wait-timeout", "180", "postgres"]);
    }
  }
}
