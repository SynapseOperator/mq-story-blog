import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { parseDeploymentAdminArguments, verifyDeploymentAdminConnection } from "../scripts/production/admin-cli.mjs";
import { validateDeploymentConfig, deploymentDatabaseTag } from "../scripts/production/database-config.mjs";

const config = validateDeploymentConfig({ version: 1, environment: "production", deploymentId: "12345678-1234-4234-8234-123456789abc",
  database: { host: "postgres", port: 5432, name: "mq_production" }, origin: "https://synthetic.invalid",
  media: { root: "/var/lib/mq/media", minFreeBytes: 8 * 1024 ** 3 } });
const confirmation = `--confirm-production=${config.deploymentId}`;

test("deployment admin mutations need exact target confirmation; status is read-only", () => {
  assert.deepEqual(parseDeploymentAdminArguments(["--operation", "status"], config), { database: "mq_production", operation: "status" });
  assert.deepEqual(parseDeploymentAdminArguments(["--operation", "init", "--username", "Synthetic_Admin", confirmation], config),
    { database: "mq_production", operation: "init", username: "synthetic_admin" });
  for (const args of [
    ["--operation", "init", "--username", "synthetic_admin"],
    ["--operation", "init", "--username", "synthetic_admin", "--confirm-production=another"],
    ["--operation", "init", "--username", "synthetic_admin", confirmation, confirmation],
    ["--operation", "init", "--username", "synthetic_admin", confirmation, "--password", "must-not-be-accepted"],
    ["--operation", "status", confirmation],
    ["--database", "mq_development", "--operation", "status"],
  ]) assert.throws(() => parseDeploymentAdminArguments(args, config));
  assert.throws(() => parseDeploymentAdminArguments(["--operation", "init", "--username", "synthetic_admin", confirmation],
    { ...config, environment: "staging" }));
});

test("wrong deployment, role or delegated session identity fails before privilege queries", async () => {
  const context = { database: config.database.name, actor: config.roles.maintenance, login: config.roles.maintenance,
    version: 180006, tag: deploymentDatabaseTag(config) };
  for (const change of [{ database: "mq_development" }, { tag: "other" }, { actor: config.roles.runtime },
    { login: "mq_bootstrap" }, { version: 170006 }]) {
    let count = 0;
    const pool = { async query() { count++; return { rows: [{ ...context, ...change }] }; } };
    await assert.rejects(verifyDeploymentAdminConnection(pool, config));
    assert.equal(count, 1);
  }
});

test("actual admin CLI refuses piped passwords, credential arguments and environment passwords without echo", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mq-production-admin-test-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "mq-production-admin-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  const manifest = { ...config }; delete manifest.roles;
  const file = join(directory, "deployment.json");
  await writeFile(file, JSON.stringify(manifest), { mode: 0o444 });
  const cli = new URL("../scripts/production/admin-cli.mjs", import.meta.url);
  const secret = "Synthetic-password-not-for-logging-42!";
  for (const extra of [{}, { ADMIN_PASSWORD: secret }, { MAINTENANCE_DATABASE_URL: `postgresql://maintenance:${secret}@postgres/mq_production` }]) {
    const result = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fileURLToPath(cli), "--operation", "init", "--username", "synthetic_admin", confirmation], {
      env: { ...process.env, MQ_DEPLOYMENT_ENV: "production", MQ_DEPLOYMENT_CONFIG: file, ...extra },
      input: secret + "\n", encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "ADMIN_DEPLOYMENT_REJECTED; connection and password details withheld");
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
});
