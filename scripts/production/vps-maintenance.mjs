import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import https from "node:https";
import { URL } from "node:url";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "./database-config.mjs";

const reserve = 8 * 1024 ** 3;
async function requireSpace(directory) {
  const disk = await statfs(directory);
  assert.ok(disk.bavail * disk.bsize >= reserve, "VPS_DISK_RESERVE_REQUIRED");
}

function requestStatus(origin, ca, path) {
  return new Promise((resolve, reject) => {
    const request = https.get(new URL(path, origin), { ca, servername: "mq.localhost", timeout: 45000,
      lookup(_host, options, done) { done(null, ...(options.all ? [[{ address: "127.0.0.1", family: 4 }]] : ["127.0.0.1", 4])); },
    }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject); request.on("timeout", () => request.destroy(new Error("VPS_HTTPS_TIMEOUT")));
  });
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
  try {
    if (action === "faults") {
      compose(["kill", "-s", "SIGKILL", "app"]);
      compose(["up", "-d", "--wait", "--wait-timeout", "180", "app"]);
      assert.equal(await requestStatus(manifest.origin, ca, "/api/stories"), 200);
      pass("application crash and explicit restart preserve serving");
      compose(["stop", "postgres"]);
      assert.equal(await requestStatus(manifest.origin, ca, "/api/stories"), 503);
      compose(["up", "-d", "--wait", "--wait-timeout", "120", "postgres"]);
      assert.equal(await requestStatus(manifest.origin, ca, "/api/stories"), 200);
      pass("database disconnection fails closed and recovers");
      for (const setting of ["MQ_DEPLOYMENT_ENV=development", "AUTH_SECRET=not-allowed-raw-value"]) {
        const refusal = compose(["run", "--rm", "--no-deps", "-e", setting, "app"], { fail: false, timeout: 30000 });
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
      docker([...args, images.tools, "scripts/production/lab-actions.mjs", "disk-refusal"]);
      pass("real low-capacity tmpfs refuses media writes without filling the host");
      compose(["stop", "app", "proxy"]);
      compose(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "120", "postgres"]);
      compose(["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180", "app", "proxy"]);
      assert.equal(await requestStatus(manifest.origin, ca, "/api/stories"), 200);
      pass("database application and proxy containers recreated with existing volumes");
    } else {
      const secret = () => randomBytes(32).toString("hex");
      const backupUrl = new URL(bootstrapUrl); backupUrl.username = config.roles.backup; backupUrl.password = passwords.backup;
      const resticPassword = secret();
      await volume("operations", {});
      await volume("backup-secrets", { bootstrap_database_url: bootstrapUrl, backup_database_url: backupUrl.href, restic_password: resticPassword });
      const targetId = randomUUID(), targetManifest = { ...manifest, deploymentId: targetId,
        database: { ...manifest.database, name: `mq_staging_${targetId.replaceAll("-", "")}` } };
      const targetConfig = validateDeploymentConfig(targetManifest);
      const targetPasswords = Object.fromEntries(LOGIN_IDENTITIES.map(name => [name, secret()]));
      const targetBootstrap = new URL(bootstrapUrl); targetBootstrap.pathname = `/${targetManifest.database.name}`;
      const targetUrl = name => { const value = new URL(targetBootstrap); value.username = targetConfig.roles[name]; value.password = targetPasswords[name]; return value.href; };
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
      compose(["stop", "proxy", "app"]);
      const began = Date.now(), backup = data(op("backup"));
      result.backupMs = Date.now() - began; result.snapshotId = backup.snapshotId;
      const receipt = data(op("receipt")); assert.equal(receipt.verified, true); assert.equal(receipt.deploymentId, config.deploymentId);
      assert.equal(op("backup", { fail: false }).status, 1);
      pass("encrypted database and media backup verified; repeated invocation refused");
      await requireSpace(directory);
      op("create-target"); op("bootstrap", { target: true, script: "scripts/production/database-cli.mjs" });
      const restoring = Date.now();
      op("restore", { target: true, env: { MQ_BACKUP_SNAPSHOT_ID: backup.snapshotId } });
      result.restoreMs = Date.now() - restoring;
      assert.equal(op("restore", { target: true, env: { MQ_BACKUP_SNAPSHOT_ID: backup.snapshotId }, fail: false }).status, 1);
      op("resume", { target: true }); op("provision", { target: true, script: "scripts/production/database-cli.mjs" });
      op("assert-restored", { target: true });
      pass("fresh target restores records constraints and least privilege; sessions and signing authority cleared");
      const override = join(directory, "restored-app.yaml");
      await writeFile(override, `services:\n  app:\n    volumes:\n      - restore-manifest:/etc/mq:ro\n      - restore-secrets:/run/secrets:ro\n      - restore-media:/var/lib/mq/media\n    environment:\n      MQ_PUBLISH_ENABLED: "false"\n      MQ_COMMENTS_ENABLED: "false"\nvolumes:\n  restore-manifest: { external: true, name: ${volumeNames["restore-manifest"]} }\n  restore-secrets: { external: true, name: ${volumeNames["restore-secrets"]} }\n  restore-media: { external: true, name: ${volumeNames["restore-media"]} }\n`, { flag: "wx", mode: 0o600 });
      docker([...composeBase, "-f", override, "up", "-d", "--force-recreate", "--wait", "--wait-timeout", "180", "app", "proxy"]);
      assert.equal(await requestStatus(manifest.origin, ca, "/api/stories"), 200);
      result.restoreToServingMs = Date.now() - restoring;
      result.restoredDeploymentId = targetId;
      result.restoredDatabase = targetManifest.database.name;
      result.override = override;
      ctx.state.phase = "restored";
      ctx.state.restored = { deploymentId: targetId, database: targetManifest.database.name, override };
      await ctx.save();
      await writeFile(join(directory, "restore-receipt.json"), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
      pass("restored app starts behind the same private HTTPS ingress; publication stays disabled");
    }
    await requireSpace(directory);
    await writeFile(join(directory, `${action}-result.json`), JSON.stringify(result, null, 2), { flag: "wx", mode: 0o600 });
    return result;
  } catch {
    const closed = compose(["stop", "proxy", "app"], { fail: false });
    throw new Error(closed.status === 0 ? "VPS_ACCEPTANCE_FAILED_ENTRANCE_CLOSED" : "VPS_ACCEPTANCE_FAILED_CONTAINMENT_UNCONFIRMED");
  }
}
