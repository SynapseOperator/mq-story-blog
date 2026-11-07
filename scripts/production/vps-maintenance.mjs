import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import https from "node:https";
import { URL } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "./database-config.mjs";

const reserve = 8 * 1024 ** 3;
async function requireSpace(directory) {
  const disk = await statfs(directory);
  assert.ok(disk.bavail * disk.bsize >= reserve, "VPS_DISK_RESERVE_REQUIRED");
}

function requestStatus(origin, ca, path, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const request = https.get(new URL(path, origin), { ca, servername: "mq.localhost",
      lookup(_host, options, done) { done(null, ...(options.all ? [[{ address: "127.0.0.1", family: 4 }]] : ["127.0.0.1", 4])); },
    }, response => { response.resume(); response.on("end", () => { clearTimeout(timer); resolve(response.statusCode); }); });
    const timer = setTimeout(() => request.destroy(Object.assign(new Error("VPS_HTTPS_TIMEOUT"), { code: "ETIMEDOUT" })), timeoutMs);
    request.on("error", error => { clearTimeout(timer); reject(error); });
  });
}

// Compose waits for proxy's running state, not its TLS listener. Only this
// read-only startup probe retries; a verified HTTPS 200 is still required.
export async function waitForHttpsReady(origin, ca, { maxAttempts = 60, totalMs = 30000, intervalMs = 500,
  requestTimeoutMs = 2000, onFailure = () => {} } = {}) {
  const deadline = Date.now() + totalMs;
  for (let attempt = 1; attempt <= maxAttempts && Date.now() < deadline; attempt++) {
    let status;
    try { status = await requestStatus(origin, ca, "/api/stories", Math.min(requestTimeoutMs, deadline - Date.now())); }
    catch (error) {
      const allowed = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"];
      onFailure({ attempt, errorCode: allowed.includes(error?.code) ? error.code : "OTHER" });
      if (!["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error?.code)) throw error;
    }
    if (status === 200) return 200;
    if (status !== undefined) {
      onFailure({ attempt, httpStatus: status });
      assert.ok(status === 502 || status === 503, "VPS_HTTPS_STATUS_REJECTED");
    }
    if (attempt < maxAttempts && Date.now() < deadline) await delay(Math.min(intervalMs, deadline - Date.now()));
  }
  throw new Error("VPS_HTTPS_NOT_READY");
}

/** Fixed synthetic acceptance actions only; never accepts SQL, paths or a
 * production target from HTTP. The root operator invokes this over SSH. */
export async function runVpsMaintenance(ctx, action) {
  const { docker, compose, composeBase, directory, project, manifest, config, images, volume, volumeNames,
    files, passwords, bootstrapUrl } = ctx;
  assert.equal(manifest.environment, "staging");
  assert.match(project, /^mq-p501-[a-f0-9]{32}$/);
  assert.ok(["faults", "restore"].includes(action), "VPS_ACTION_REJECTED");
  assert.equal(ctx.state.phase, "healthy", "VPS_ACCEPTANCE_PHASE_REJECTED");
  await requireSpace(directory);
  const result = { action, synthetic: true, productionDeployed: false, checks: [] };
  const pass = name => { result.checks.push(name); console.log(`PASS VPS: ${name}`); };
  const ca = await readFile(join(directory, "local-ca.pem"), "utf8");
  if (action === "restore") {
    // Claim before touching backup passwords or named volumes. An interrupted
    // restore needs inspection, never an automatic overwrite of its recovery key.
    await writeFile(join(directory, "restore-started.json"), JSON.stringify({ startedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    ctx.state.phase = "restore-started"; await ctx.save();
  }
  let stage = "begin", observed = {};
  const enter = name => { stage = name; observed = {}; };
  const expectHttp = async (expected, readiness = false) => {
    if (readiness) observed.readiness = [];
    observed.httpStatus = readiness ? await waitForHttpsReady(manifest.origin, ca, { onFailure: observation => {
      observed.readiness.push(observation);
      if (observation.httpStatus !== undefined) observed.httpStatus = observation.httpStatus;
      (result.readiness ??= []).push({ stage, ...observation });
      console.log(`VPS_HTTPS_NOT_READY=${JSON.stringify({ stage, ...observation })}`);
    } }) : await requestStatus(manifest.origin, ca, "/api/stories");
    assert.equal(observed.httpStatus, expected);
  };
  try {
    if (action === "faults") {
      enter("crash-kill");
      compose(["kill", "-s", "SIGKILL", "app"]);
      enter("crash-restart");
      compose(["up", "-d", "--wait", "--wait-timeout", "180", "app"]);
      enter("crash-https"); await expectHttp(200, true);
      pass("application crash and explicit restart preserve serving");
      enter("database-stop");
      compose(["stop", "postgres"]);
      enter("database-unavailable-https"); await expectHttp(503);
      enter("database-restart");
      compose(["up", "-d", "--wait", "--wait-timeout", "120", "postgres"]);
      enter("database-recovered-https"); await expectHttp(200);
      pass("database disconnection fails closed and recovers");
      for (const setting of ["MQ_DEPLOYMENT_ENV=development", "AUTH_SECRET=not-allowed-raw-value"]) {
        enter(setting.startsWith("MQ_DEPLOYMENT_ENV") ? "invalid-environment-startup" : "inline-secret-startup");
        const refusal = compose(["run", "--rm", "--no-deps", "-e", setting, "app"], { fail: false, timeout: 30000 });
        if (Number.isInteger(refusal.status)) observed.processExitCode = refusal.status;
        assert.equal(refusal.status, 1); assert.match(refusal.stderr, /MQ_STARTUP_REJECTED/);
      }
      pass("wrong environment and inline secret cannot start");
      const args = ["run", "--rm", "--read-only", "--cap-drop", "ALL", "--network", `${project}_database`,
        "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
        "--mount", `type=volume,source=${volumeNames.manifest},target=/etc/mq,readonly`,
        "--mount", `type=volume,source=${volumeNames["app-secrets"]},target=/run/secrets,readonly`,
        "--tmpfs", "/var/lib/mq/media:rw,noexec,nosuid,size=8m,uid=10001,gid=10001,mode=0700"];
      for (const [name, value] of Object.entries({ NODE_ENV: "production", MQ_SYNTHETIC_LAB: "true", MQ_DEPLOYMENT_ENV: "staging",
        MQ_DEPLOYMENT_CONFIG: "/etc/mq/deployment.json", DATABASE_URL_FILE: "/run/secrets/database_url",
        AUTH_SECRET_FILE: "/run/secrets/auth_secret", AUTH_PROXY_SECRET_FILE: "/run/secrets/auth_proxy_secret",
        MQ_PUBLISH_SIGNING_KEY_FILE: "/run/secrets/publish_signing_key", MQ_COMMENT_SIGNING_KEY_FILE: "/run/secrets/comment_signing_key" })) args.push("-e", `${name}=${value}`);
      enter("low-disk-tmpfs");
      docker([...args, images.tools, "scripts/production/lab-actions.mjs", "disk-refusal"]);
      pass("real low-capacity tmpfs refuses media writes without filling the host");
      enter("recreate-close-ingress");
      compose(["stop", "app", "proxy"]);
      enter("recreate-database");
      compose(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "120", "postgres"]);
      enter("recreate-app-proxy");
      compose(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180", "app", "proxy"]);
      enter("recreate-https"); await expectHttp(200, true);
      pass("database application and proxy containers recreated with existing volumes");
    } else {
      const secret = () => randomBytes(32).toString("hex");
      const backupUrl = new URL(bootstrapUrl); backupUrl.username = config.roles.backup; backupUrl.password = passwords.backup;
      const resticPassword = secret();
      enter("restore-backup-volumes");
      await volume("operations", {});
      await volume("backup-secrets", { bootstrap_database_url: bootstrapUrl, backup_database_url: backupUrl.href, restic_password: resticPassword });
      const targetId = randomUUID(), targetManifest = { ...manifest, deploymentId: targetId,
        database: { ...manifest.database, name: `mq_staging_${targetId.replaceAll("-", "")}` } };
      const targetConfig = validateDeploymentConfig(targetManifest);
      const targetPasswords = Object.fromEntries(LOGIN_IDENTITIES.map(name => [name, secret()]));
      const targetBootstrap = new URL(bootstrapUrl); targetBootstrap.pathname = `/${targetManifest.database.name}`;
      const targetUrl = name => { const value = new URL(targetBootstrap); value.username = targetConfig.roles[name]; value.password = targetPasswords[name]; return value.href; };
      enter("restore-target-volumes");
      await volume("restore-manifest", { "deployment.json": JSON.stringify(targetManifest) });
      await volume("restore-media", {});
      await volume("restore-secrets", { bootstrap_database_url: targetBootstrap.href, role_passwords: JSON.stringify(targetPasswords),
        migration_database_url: targetUrl("migration"), database_url: targetUrl("runtime"), restic_password: resticPassword,
        auth_secret: secret(), auth_proxy_secret: files.auth_proxy_secret, publish_signing_key: secret(), comment_signing_key: secret() });
      const op = (name, { target = false, script = "scripts/production/operations-lab-actions.mjs", env = {}, fail = true } = {}) => {
        const args = ["run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
          "--network", `${project}_database`, "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
          "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700",
          "--mount", `type=volume,source=${volumeNames[target ? "restore-manifest" : "manifest"]},target=/etc/mq,readonly`,
          "--mount", `type=volume,source=${volumeNames["restore-manifest"]},target=/etc/mq-restore,readonly`,
          "--mount", `type=volume,source=${target ? volumeNames["restore-media"] : `${project}_media`},target=/var/lib/mq/media`,
          "--mount", `type=volume,source=${volumeNames.operations},target=/var/lib/mq/operations`,
          "--mount", `type=volume,source=${volumeNames[target ? "restore-secrets" : "backup-secrets"]},target=/run/secrets,readonly`];
        for (const [key, value] of Object.entries({ MQ_SYNTHETIC_LAB: "true", MQ_DEPLOYMENT_ENV: "staging",
          MQ_DEPLOYMENT_CONFIG: "/etc/mq/deployment.json", MQ_RESTORE_CONFIG: "/etc/mq-restore/deployment.json",
          BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url", BACKUP_DATABASE_URL_FILE: "/run/secrets/backup_database_url",
          MIGRATION_DATABASE_URL_FILE: "/run/secrets/migration_database_url", RUNTIME_DATABASE_URL_FILE: "/run/secrets/database_url",
          MQ_ROLE_PASSWORDS_FILE: "/run/secrets/role_passwords", RESTIC_PASSWORD_FILE: "/run/secrets/restic_password",
          MQ_LAB_REVISION: ctx.sourceSha, ...env })) args.push("-e", `${key}=${value}`);
        return docker([...args, images.operations, script, name], { fail, timeout: 600000 });
      };
      const data = output => JSON.parse(output.stdout.trim().split("\n").at(-1));
      enter("restore-close-ingress");
      compose(["stop", "proxy", "app"]);
      enter("restore-backup");
      const began = Date.now(), backup = data(op("backup"));
      result.backupMs = Date.now() - began; result.snapshotId = backup.snapshotId;
      enter("restore-backup-receipt");
      const receipt = data(op("receipt")); assert.equal(receipt.verified, true); assert.equal(receipt.deploymentId, config.deploymentId);
      enter("restore-backup-repeat-refusal");
      observed.processExitCode = op("backup", { fail: false }).status;
      assert.equal(observed.processExitCode, 1);
      pass("encrypted database and media backup verified; repeated invocation refused");
      enter("restore-disk-reserve");
      await requireSpace(directory);
      enter("restore-create-target"); op("create-target");
      enter("restore-bootstrap-target"); op("bootstrap", { target: true, script: "scripts/production/database-cli.mjs" });
      const restoring = Date.now();
      enter("restore-data");
      op("restore", { target: true, env: { MQ_BACKUP_SNAPSHOT_ID: backup.snapshotId } });
      result.restoreMs = Date.now() - restoring;
      enter("restore-repeat-refusal");
      observed.processExitCode = op("restore", { target: true, env: { MQ_BACKUP_SNAPSHOT_ID: backup.snapshotId }, fail: false }).status;
      assert.equal(observed.processExitCode, 1);
      enter("restore-resume-target"); op("resume", { target: true });
      enter("restore-provision-target"); op("provision", { target: true, script: "scripts/production/database-cli.mjs" });
      enter("restore-permission-audit");
      op("assert-restored", { target: true });
      pass("fresh target restores records constraints and least privilege; sessions and signing authority cleared");
      const override = join(directory, "restored-app.yaml");
      enter("restore-app-configuration");
      await writeFile(override, `services:\n  app:\n    volumes:\n      - restore-manifest:/etc/mq:ro\n      - restore-secrets:/run/secrets:ro\n      - restore-media:/var/lib/mq/media\n    environment:\n      MQ_PUBLISH_ENABLED: "false"\n      MQ_COMMENTS_ENABLED: "false"\nvolumes:\n  restore-manifest: { external: true, name: ${volumeNames["restore-manifest"]} }\n  restore-secrets: { external: true, name: ${volumeNames["restore-secrets"]} }\n  restore-media: { external: true, name: ${volumeNames["restore-media"]} }\n`, { flag: "wx", mode: 0o600 });
      enter("restore-app-start");
      docker([...composeBase, "-f", override, "up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180", "app", "proxy"]);
      enter("restore-https"); await expectHttp(200, true);
      result.restoreToServingMs = Date.now() - restoring;
      result.restoredDeploymentId = targetId;
      result.restoredDatabase = targetManifest.database.name;
      result.override = override;
      ctx.state.phase = "restored";
      ctx.state.restored = { deploymentId: targetId, database: targetManifest.database.name, override };
      enter("restore-receipt");
      await ctx.save();
      await writeFile(join(directory, "restore-receipt.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
      pass("restored app starts behind the same private HTTPS ingress; publication stays disabled");
    }
    enter("final-disk-reserve");
    await requireSpace(directory);
    enter("final-result");
    await writeFile(join(directory, `${action}-result.json`), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
    return result;
  } catch (error) {
    const closed = compose(["stop", "proxy", "app"], { fail: false });
    // Persist only fixed stages and primitive observations. Child errors may
    // contain SQL, credentials or signed URLs; never serialize them wholesale.
    const failure = { action, stage, containment: closed.status === 0 ? "closed" : "unconfirmed" };
    if (observed.readiness?.length) failure.readiness = observed.readiness;
    if (Number.isInteger(observed.httpStatus) && observed.httpStatus >= 100 && observed.httpStatus <= 599) failure.httpStatus = observed.httpStatus;
    if (Number.isInteger(observed.processExitCode) && observed.processExitCode >= 0 && observed.processExitCode <= 255) failure.processExitCode = observed.processExitCode;
    if (["ERR_ASSERTION", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ENOENT", "EACCES", "ENOSPC",
      "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT"].includes(error?.code)) failure.errorCode = error.code;
    // A diagnostic write failure must not interfere with closing the entrance.
    await Promise.allSettled([writeFile(join(directory, `${action}-failure-${randomUUID()}.json`),
      JSON.stringify(failure), { flag: "wx", mode: 0o600 })]);
    console.error(`VPS_MAINTENANCE_FAILURE=${JSON.stringify(failure)}`);
    // Do not attach the raw cause: a native terminal may render its credentials.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(closed.status === 0 ? "VPS_ACCEPTANCE_FAILED_ENTRANCE_CLOSED" : "VPS_ACCEPTANCE_FAILED_CONTAINMENT_UNCONFIRMED");
  }
}
