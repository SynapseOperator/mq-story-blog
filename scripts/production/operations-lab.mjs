import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";
import { chromium } from "playwright";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "./database-config.mjs";
import { collectOperations } from "./operations-check.mjs";
import { startS3Lab } from "./s3-lab.mjs";
import { runReleaseLab } from "./release-lab.mjs";

/** Reuse the real deployment lab, including Caddy/HTTP, without introducing a
 * second application/bootstrap harness. Every name and secret is synthetic. */
async function runOperationsLabImpl(ctx, fixture) {
  const { docker, compose, composeBase, project, config, manifest, files, passwords, bootstrapUrl,
    directory, evidence, images, volume, volumeNames, secret, origin, ca, accounts, revision } = ctx;
  const { request, story, asset, adminJar, readerJar } = fixture;
  const result = { synthetic: true, productionDeployed: false, checks: [] };
  const remote = ctx.release ? await startS3Lab(ctx) : null;
  const pass = name => { result.checks.push(name); console.log(`PASS operations: ${name}`); };
  const newImage = await request(`/api/admin/media/${asset.id}/content`, { jar: adminJar }); assert.equal(newImage.status, 200);
  const privateUpload = await request("/api/admin/media", { method: "POST", jar: adminJar, bytes: newImage.bytes,
    headers: { "content-type": "image/webp", "idempotency-key": randomUUID() } });
  assert.equal(privateUpload.status, 201);
  const privateAsset = privateUpload.data.asset;
  const draft = await request("/api/admin/stories", { method: "POST", jar: adminJar,
    body: { kind: "STAR", title: "恢复隔离验证 · 未公开合成草稿", content: { version: 2, blocks: [
      { type: "paragraph", text: "只供恢复验证的合成内容" }, { type: "image", assetId: privateAsset.id, alt: "未公开合成图片" }] } } });
  assert.equal(draft.status, 201);

  const backupUrl = new URL(bootstrapUrl); backupUrl.username = config.roles.backup; backupUrl.password = passwords.backup;
  await volume("operations", {});
  await volume("backup-secrets", { bootstrap_database_url: bootstrapUrl, backup_database_url: backupUrl.href, restic_password: secret() });
  const targetId = randomUUID();
  const targetManifest = { ...manifest, deploymentId: targetId,
    database: { ...manifest.database, name: `mq_staging_${targetId.replaceAll("-", "")}` } };
  const targetConfig = validateDeploymentConfig(targetManifest);
  const targetPasswords = Object.fromEntries(LOGIN_IDENTITIES.map(name => [name, secret()]));
  const targetBootstrap = new URL(bootstrapUrl); targetBootstrap.pathname = `/${targetConfig.database.name}`;
  const targetUrl = name => { const url = new URL(targetBootstrap); url.username = targetConfig.roles[name]; url.password = targetPasswords[name]; return url.href; };
  await volume("restore-manifest", { "deployment.json": JSON.stringify(targetManifest) });
  await volume("restore-media", {});
  await volume("restore-secrets", { bootstrap_database_url: targetBootstrap.href, role_passwords: JSON.stringify(targetPasswords),
    migration_database_url: targetUrl("migration"), database_url: targetUrl("runtime"), restic_password: await ctx.readVolumeSecret("backup-secrets", "restic_password"),
    auth_secret: secret(), auth_proxy_secret: files.auth_proxy_secret, publish_signing_key: secret(), comment_signing_key: secret() });

  const op = (action, { target = false, group = target ? "restore-secrets" : "backup-secrets", env = {}, script = "scripts/production/operations-lab-actions.mjs", extra = [], fail = true } = {}) => {
    const args = ["run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--network", `${project}_database`, "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700",
      "--mount", `type=volume,source=${volumeNames[target ? "restore-manifest" : "manifest"]},target=/etc/mq,readonly`,
      "--mount", `type=volume,source=${volumeNames["restore-manifest"]},target=/etc/mq-restore,readonly`,
      "--mount", `type=volume,source=${target ? volumeNames["restore-media"] : `${project}_media`},target=/var/lib/mq/media`,
      "--mount", `type=volume,source=${volumeNames.operations},target=/var/lib/mq/operations`,
      "--mount", `type=volume,source=${volumeNames[group]},target=/run/secrets,readonly`];
    if (remote) args.push("--mount", `type=volume,source=${volumeNames["remote-credentials"]},target=/run/s3,readonly`,
      "--mount", `type=volume,source=${volumeNames["remote-ca"]},target=/etc/mq-s3,readonly`);
    const environment = { MQ_SYNTHETIC_LAB: "true", MQ_DEPLOYMENT_ENV: "staging", MQ_DEPLOYMENT_CONFIG: "/etc/mq/deployment.json",
      MQ_RESTORE_CONFIG: "/etc/mq-restore/deployment.json", BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url",
      BACKUP_DATABASE_URL_FILE: "/run/secrets/backup_database_url", MIGRATION_DATABASE_URL_FILE: "/run/secrets/migration_database_url",
      RUNTIME_DATABASE_URL_FILE: "/run/secrets/database_url", MQ_ROLE_PASSWORDS_FILE: "/run/secrets/role_passwords",
      RESTIC_PASSWORD_FILE: "/run/secrets/restic_password", MQ_LAB_REVISION: revision,
      ...(remote ? { MQ_LAB_S3_REPOSITORY: remote.repository } : {}), ...env };
    for (const [name, value] of Object.entries(environment)) args.push("-e", `${name}=${value}`);
    return docker([...args, images.operations, script, action, ...extra], { fail, timeout: 600000 });
  };
  const data = output => JSON.parse(output.stdout.trim().split("\n").at(-1));
  compose(["stop", "app"]);
  const backupStarted = Date.now();
  const backup = data(op("backup")); result.snapshotId = backup.snapshotId;
  result.backupMs = Date.now() - backupStarted;
  const receipt = data(op("receipt")); assert.equal(receipt.verified, true); assert.equal(receipt.deploymentId, config.deploymentId);
  pass("read-only backup identity, encrypted Restic snapshot and independent full verification");
  // A second identical receipt/initialization is refused; no implicit overwrite.
  assert.equal(op("backup", { fail: false }).status, 1);
  pass("duplicate backup invocation cannot overwrite a verified receipt");
  if (remote) {
    op("remote-negative"); op("retention");
    result.backupBackend = "s3-https-moto";
    pass("S3 HTTPS repository identity, wrong password/credentials/CA, no receipt on failure and retention dry-run");
  }

  op("create-target");
  op("bootstrap", { target: true, script: "scripts/production/database-cli.mjs" });
  const restoreStarted = Date.now();
  op("restore", { target: true, env: { MQ_BACKUP_SNAPSHOT_ID: backup.snapshotId } });
  result.restoreMs = Date.now() - restoreStarted;
  // A second recovery cannot overwrite the now-populated target.
  assert.equal(op("restore", { target: true, env: { MQ_BACKUP_SNAPSHOT_ID: backup.snapshotId }, fail: false }).status, 1);
  // The new target still has bootstrap-only CONNECT grants and no application
  // process. Explicit LOGIN resumption precedes the existing atomic provision
  // audit, which deliberately requires the final login flags.
  op("resume", { target: true });
  op("provision", { target: true, script: "scripts/production/database-cli.mjs" });
  op("assert-restored", { target: true });
  pass("fresh database/media restore, constraints and least privilege, sessions and business keys cleared");

  const override = join(directory, "restored-app.yaml");
  await writeFile(override, `services:
  app:
    volumes:
      - restore-manifest:/etc/mq:ro
      - restore-secrets:/run/secrets:ro
      - restore-media:/var/lib/mq/media
    environment:
      MQ_PUBLISH_ENABLED: "false"
      MQ_COMMENTS_ENABLED: "false"
volumes:
  restore-manifest: { external: true, name: ${volumeNames["restore-manifest"]} }
  restore-secrets: { external: true, name: ${volumeNames["restore-secrets"]} }
  restore-media: { external: true, name: ${volumeNames["restore-media"]} }
`);
  docker([...composeBase, "-f", override, "up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180", "app"]);
  assert.equal((await request("/api/admin/stories", { jar: adminJar })).status, 401);
  assert.equal((await request(`/api/stories/${story.id}/likes`, { jar: readerJar })).data.liked, false);
  assert.equal((await request(`/api/stories/${story.id}`)).data.story.title, story.draftTitle);
  assert.equal((await request(`/api/stories/${draft.data.story.id}`)).status, 404);
  for (const method of ["GET", "HEAD"]) {
    assert.equal((await request(`/api/stories/${story.id}/media/${privateAsset.id}`, { method })).status, 404);
    assert.equal((await request(`/api/admin/media/${privateAsset.id}/content`, { method })).status, 401);
    assert.equal((await request(`/api/stories/${story.id}/media/${asset.id}`, { method })).status, 200);
  }
  const restoredBytes = await request(`/api/stories/${story.id}/media/${asset.id}`);
  assert.equal(createHash("sha256").update(restoredBytes.bytes).digest("hex"), asset.display.sha256);
  assert.equal((await request(`/api/stories/${story.id}/comments`)).data.count, 1);
  const restoredAdmin = {};
  assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: accounts.admin, jar: restoredAdmin })).status, 200);
  assert.equal((await request(`/api/admin/media/${privateAsset.id}/content`, { jar: restoredAdmin })).status, 200);
  assert.equal((await request(`/api/admin/stories/${story.id}/withdraw`, { method: "POST", jar: restoredAdmin, body: { expectedVersion: story.version } })).status, 503);
  pass("restored HTTPS app reads correct public/private data; old cookie and publication authority denied");

  const browser = await chromium.launch();
  try {
    for (const [name, viewport] of [["desktop", { width: 1536, height: 1024 }], ["mobile", { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, ignoreHTTPSErrors: true,
        ...(name === "mobile" ? { isMobile: true, hasTouch: true, reducedMotion: "reduce" } : {}) });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", () => errors.push("runtime"));
      page.on("console", entry => { if (entry.type() === "error") errors.push("console"); });
      assert.equal((await page.goto(`${origin}/stories/${story.slug}`)).status(), 200);
      await page.locator('dialog[data-phase="reading"]').waitFor();
      await page.getByRole("heading", { name: story.draftTitle, exact: true }).waitFor();
      await page.getByRole("img", { name: "合成蓝灰色图片", exact: true }).evaluate(image => image.decode());
      assert.equal(await page.locator("nextjs-portal").count(), 0);
      await page.screenshot({ path: join(evidence, `restored-${name}.png`), scale: "device" });
      assert.deepEqual(errors, []); await context.close();
    }
  } finally { await browser.close(); }
  result.restoreToServingMs = Date.now() - restoreStarted;
  pass("restored application desktop/mobile rendering and actual image decode");

  compose(["stop", "app"]);
  const replacements = Object.fromEntries(LOGIN_IDENTITIES.map(name => [name, secret()]));
  const replacementKeys = { auth_secret: secret(), auth_proxy_secret: secret(), publish_signing_key: secret(), comment_signing_key: secret() };
  await volume("rotation-secrets", { bootstrap_database_url: bootstrapUrl, old_passwords: JSON.stringify(passwords), new_passwords: JSON.stringify(replacements),
    previous_publish: files.publish_signing_key, previous_comment: files.comment_signing_key,
    next_publish: replacementKeys.publish_signing_key, next_comment: replacementKeys.comment_signing_key });
  const rotation = action => op(action, { group: "rotation-secrets", script: "scripts/production/rotation-cli.mjs",
    extra: [`--confirm-deployment=${config.deploymentId}`], env: { MQ_NEW_ROLE_PASSWORDS_FILE: "/run/secrets/new_passwords",
      MQ_PREVIOUS_PUBLISH_SIGNING_KEY_FILE: "/run/secrets/previous_publish", MQ_PREVIOUS_COMMENT_SIGNING_KEY_FILE: "/run/secrets/previous_comment",
      MQ_NEW_PUBLISH_SIGNING_KEY_FILE: "/run/secrets/next_publish", MQ_NEW_COMMENT_SIGNING_KEY_FILE: "/run/secrets/next_comment" } });
  rotation("database"); rotation("signing"); rotation("resume");
  op("assert-credentials", { group: "rotation-secrets", env: { MQ_OLD_ROLE_PASSWORDS_FILE: "/run/secrets/old_passwords", MQ_NEW_ROLE_PASSWORDS_FILE: "/run/secrets/new_passwords" } });
  const changedUrl = name => { const url = new URL(bootstrapUrl); url.username = config.roles[name]; url.password = replacements[name]; return url.href; };
  await volume("app-secrets", { database_url: changedUrl("runtime"), ...replacementKeys });
  await volume("proxy-secrets", { auth_proxy_secret: replacementKeys.auth_proxy_secret });
  await volume("maintenance-secrets", { maintenance_database_url: changedUrl("maintenance"), accounts: files.accounts });
  compose(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180", "app", "proxy"]);
  assert.equal((await request("/api/admin/stories", { jar: adminJar })).status, 401);
  const refreshed = {};
  assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: accounts.admin, jar: refreshed })).status, 200);
  assert.equal((await request("/api/admin/stories", { jar: refreshed, headers: { "x-mq-proxy-key": files.auth_proxy_secret, "x-mq-client-ip": "forged" } })).status, 200);
  assert.equal((await request(`/api/stories/${story.id}`)).status, 200);
  const withdrawn = await request(`/api/admin/stories/${story.id}/withdraw`, { method: "POST", jar: refreshed, body: { expectedVersion: story.version } });
  assert.equal(withdrawn.status, 200);
  assert.equal((await request(`/api/stories/${story.id}/media/${asset.id}`, { method: "HEAD" })).status, 404);
  assert.equal((await request(`/api/admin/stories/${story.id}/restore`, { method: "POST", jar: refreshed,
    body: { expectedVersion: withdrawn.data.story.version } })).status, 200);
  const pending = await request(`/api/stories/${story.id}/comments`, { method: "POST", headers: { "idempotency-key": randomUUID() },
    body: { body: "密钥轮换后的合成审核验证", identity: "anonymous" } });
  assert.equal(pending.status, 202);
  assert.equal((await request(`/api/admin/comments/${pending.data.receiptId}/moderate`, { method: "POST", jar: refreshed,
    body: { action: "approve", expectedVersion: 0 } })).status, 200);
  pass("five SCRAM credentials, auth/proxy and business key rotation with forced recreation and fresh login");
  if (ctx.release) {
    await volume("release-migration-secrets", { migration_database_url: changedUrl("migration") });
    result.release = await runReleaseLab(ctx, { request, story, asset, privateAsset, oldJar: adminJar, currentJar: refreshed, receipt, databaseOperation: action => {
      op(action, { group: action === "migrate" ? "release-migration-secrets" : action === "audit" ? "app-secrets" : "backup-secrets",
        script: "scripts/production/database-cli.mjs" });
    } });
  }
  const receiptPath = join(evidence, "backup-receipt.json"); await writeFile(receiptPath, JSON.stringify(receipt));
  const monitoring = await collectOperations({ project, deploymentId: config.deploymentId, diskPath: directory, origin, receiptPath, ca, connectHost: "127.0.0.1" });
  console.log(`OPERATIONS_MONITOR ${JSON.stringify(monitoring)}`);
  // Caddy's disposable local certificate is deliberately short lived. Production
  // expiry thresholds remain unchanged and must alert, not be waived globally.
  // A hosted CI runner has just built four images: its load average is real
  // telemetry, not a capacity acceptance test for the future VPS. Preserve that
  // alert and its nonzero CLI behavior; all service/storage/TLS checks still apply.
  assert.ok(monitoring.failures.every(code => code === "TLS_EXPIRY_OR_VERIFICATION_FAILED"
    || (process.env.CI === "true" && code === "HOST_LOAD_HIGH" && monitoring.sample.loadPerCpu > 1.5)));
  assert.equal(monitoring.failures.includes("HOST_LOAD_HIGH"), monitoring.sample.loadPerCpu > 1.5);
  assert.ok(monitoring.sample.certificateDays > 0);
  result.monitoring = monitoring;
  pass("read-only host/container/backup/TLS monitoring; local short-lived certificate alert retained");
  await writeFile(join(evidence, "operations-result.json"), JSON.stringify(result, null, 2));
  return result;
}

export async function runOperationsLab(ctx, fixture) {
  try { return await runOperationsLabImpl(ctx, fixture); }
  catch (error) {
    const line = /operations-lab\.mjs:(\d+):\d+/.exec(error.stack ?? "")?.[1];
    const code = ["S3_FIXTURE_NOT_READY", "S3_TLS_NOT_READY", "RELEASE_LAB_OCI_DIGEST_MISSING"].includes(error.message) ? ` ${error.message}` : "";
    console.error(`OPERATIONS_ASSERTION_FAILED${line ? ` line=${line}` : ""}${code}`);
    throw error;
  }
}
