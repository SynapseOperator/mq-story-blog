import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "./database-config.mjs";
import { runProductionHttpChecks, laboratoryTransport } from "./http-tests.mjs";
import { runImageConfigurationChecks } from "./container-checks.mjs";
import { runOperationsLab } from "./operations-lab.mjs";
import { readRealOssLab, removeRealOssSecret } from "./oss-real-lab.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
let stage = "prepare isolated container laboratory";
const secretValues = new Set();
let diagnosticPath;
function docker(args, { fail = true, timeout = 300000, input } = {}) {
  const result = spawnSync("docker", args, { cwd: root, windowsHide: true, encoding: "utf8", input,
    timeout, maxBuffer: 20 * 1024 * 1024, env: process.env });
  if (fail && result.status !== 0) {
    let diagnostic = `${result.status}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    for (const value of secretValues) if (value) diagnostic = diagnostic.replaceAll(value, "[redacted]");
    if (diagnosticPath) writeFileSync(diagnosticPath, diagnostic, { mode: 0o600 });
    throw new Error("LAB_DOCKER_COMMAND_FAILED");
  }
  return result;
}
async function unusedPort() {
  const server = createServer(); await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}

async function main() {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && ["--operations", "--release", "--oss"].includes(process.argv[2])));
  const release = process.argv[2] === "--release";
  const oss = process.argv[2] === "--oss";
  const operations = process.argv[2] === "--operations" || release || oss;
  const id = randomUUID(), suffix = id.replaceAll("-", ""), project = `mq-p302-${suffix}`;
  const ossOptions = oss ? await readRealOssLab(id, secretValues) : null;
  const directory = await mkdtemp(join(tmpdir(), "mq-p302-lab-"));
  const evidence = process.env.PRODUCTION_EVIDENCE_DIR || join(directory, "evidence");
  await mkdir(evidence, { recursive: true });
  diagnosticPath = join(evidence, "failure.redacted.log");
  console.log(`Isolated evidence directory: ${evidence}`);
  const port = await unusedPort(), httpPort = await unusedPort();
  const origin = `https://mq.localhost:${port}`, mediaRoot = "/var/lib/mq/media";
  const manifest = { version: 1, environment: "staging", deploymentId: id,
    database: { host: "postgres", port: 5432, name: `mq_staging_${suffix}` }, origin,
    media: { root: mediaRoot, minFreeBytes: 512 * 1024 * 1024 } };
  const config = validateDeploymentConfig(manifest);
  const images = { app: process.env.MQ_LAB_APP_IMAGE || "mq-p302-app:local", tools: process.env.MQ_LAB_TOOLS_IMAGE || "mq-p302-tools:local",
    proxy: process.env.MQ_LAB_PROXY_IMAGE || "mq-p302-proxy:local",
    ...(operations ? { operations: process.env.MQ_LAB_OPERATIONS_IMAGE || "mq-p303-operations:local" } : {}) };
  const secret = () => { const value = randomBytes(32).toString("hex"); secretValues.add(value); return value; };
  const passwords = Object.fromEntries(LOGIN_IDENTITIES.map(name => [name, secret()])), bootstrapPassword = secret();
  const url = role => `postgresql://${role}:${role === "mq_bootstrap" ? bootstrapPassword : passwords[Object.keys(config.roles).find(key => config.roles[key] === role)]}@postgres:5432/${config.database.name}`;
  const runtimeUrl = url(config.roles.runtime), bootstrapUrl = url("mq_bootstrap");
  secretValues.add(runtimeUrl); secretValues.add(bootstrapUrl);
  const files = { postgres_password: bootstrapPassword, database_url: runtimeUrl, auth_secret: secret(), auth_proxy_secret: secret(),
    publish_signing_key: secret(), comment_signing_key: secret(), bootstrap_database_url: bootstrapUrl,
    migration_database_url: url(config.roles.migration), maintenance_database_url: url(config.roles.maintenance),
    role_passwords: JSON.stringify(passwords) };
  const accounts = { admin: { username: `lab_admin_${suffix.slice(0, 8)}`, password: `MqLab!${secret()}` },
    reader: { username: `lab_reader_${suffix.slice(0, 8)}`, password: `MqReader!${secret()}` } };
  secretValues.add(accounts.admin.password); secretValues.add(accounts.reader.password);
  files.accounts = JSON.stringify(accounts);
  const secretDirectory = join(directory, "files"); await mkdir(secretDirectory, { mode: 0o700 });
  for (const [name, value] of Object.entries(files)) { secretValues.add(value); await writeFile(join(secretDirectory, name), value + "\n", { mode: 0o600 }); }
  await writeFile(join(directory, "deployment.json"), JSON.stringify(manifest), { mode: 0o644 });
  const volumeNames = {}, volumeEntries = {}, temporaryContainers = new Set();
  const environmentPath = join(directory, "compose.env"), overridePath = join(directory, "lab.yaml");
  // This file contains only non-secret paths, image names, flags and the test hostname.
  await writeFile(environmentPath, Object.entries({ MQ_DEPLOYMENT_ENV: "staging", MQ_DATABASE_NAME: manifest.database.name,
    MQ_AUTH_ORIGIN: origin, MQ_PUBLIC_HOST: "mq.localhost", MQ_DEPLOYMENT_CONFIG: join(directory, "deployment.json").replaceAll("\\", "/"),
    MQ_SECRET_DIRECTORY: secretDirectory.replaceAll("\\", "/"), MQ_APP_IMAGE: images.app, MQ_TOOLS_IMAGE: images.tools,
    MQ_PROXY_IMAGE: images.proxy, MQ_AUTH_ENABLED: "true", MQ_MEDIA_ENABLED: "true", MQ_PUBLISH_ENABLED: "true", MQ_COMMENTS_ENABLED: "true",
  }).map(([name, value]) => `${name}=${value}`).join("\n"), { mode: 0o600 });
  const composeBase = ["compose", "--env-file", environmentPath, "--project-name", project, "-f", join(root, "compose.production.yaml"), "-f", overridePath];
  const compose = (args, options) => docker([...composeBase, ...args], options);
  async function volume(name, entries = {}, uid = 10001) {
    assert.match(name, /^[a-z][a-z-]*$/);
    const full = `${project}_${name}`; volumeNames[name] = full;
    volumeEntries[name] = entries;
    docker(["volume", "create", "--label", `mq.lab=${id}`, full]);
    const stageDirectory = await mkdtemp(join(directory, `${name}-`));
    for (const [file, value] of Object.entries(entries)) await writeFile(join(stageDirectory, file), value, { mode: 0o600 });
    const container = `${project}-init-${name}-${randomUUID().slice(0, 8)}`; temporaryContainers.add(container);
    docker(["create", "--name", container, "--network", "none", "--user", "0:0", "--mount", `type=volume,source=${full},target=/target`,
      // The offline tools base declares a PG data volume, unused by this copy
      // helper. An explicit tiny tmpfs avoids creating orphan anonymous volumes.
      "--mount", "type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=1048576",
      "--entrypoint", "/bin/sh", images.tools, "-c",
      `cp -R /staged/. /target/ && chown -R ${uid}:${uid} /target && chmod 0700 /target && find /target -type f -exec chmod ${name.endsWith("manifest") ? "0444" : "0400"} {} +`]);
    docker(["cp", `${stageDirectory}${process.platform === "win32" ? "\\" : "/"}.`, `${container}:/staged`]);
    docker(["start", "--attach", container]); docker(["rm", container]); temporaryContainers.delete(container);
    return full;
  }
  let succeeded = false;
  try {
    stage = "initialize scoped private volumes";
    for (const image of Object.values(images)) docker(["image", "inspect", image, "--format", "{{.Id}}"]);
    runImageConfigurationChecks({ appImage: images.app, toolsImage: images.tools, proxyImage: images.proxy });
    if (operations) {
      docker(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m,uid=10001,gid=10001,mode=0700",
        images.operations, "scripts/production/backup-tools-tests.mjs"]);
      docker(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=8m,uid=10001,gid=10001,mode=0700",
        images.operations, "--input-type=module", "--eval",
        "import assert from 'node:assert/strict'; import {requireBackupSpace} from './scripts/production/backup-tools.mjs'; await assert.rejects(requireBackupSpace('/tmp',1),/BACKUP_DISK_SPACE_LOW/);"]);
      console.log("PASS operations: real Restic faults and actual low-capacity filesystem admission");
    }
    await volume("manifest", { "deployment.json": JSON.stringify(manifest) });
    await volume("app-secrets", Object.fromEntries(["database_url", "auth_secret", "auth_proxy_secret", "publish_signing_key", "comment_signing_key"].map(name => [name, files[name]])));
    await volume("pg-secrets", { postgres_password: files.postgres_password }, 999);
    await volume("proxy-secrets", { auth_proxy_secret: files.auth_proxy_secret });
    await volume("bootstrap-secrets", { bootstrap_database_url: bootstrapUrl, role_passwords: files.role_passwords });
    await volume("migration-secrets", { migration_database_url: files.migration_database_url });
    await volume("key-secrets", { bootstrap_database_url: bootstrapUrl, publish_signing_key: files.publish_signing_key, comment_signing_key: files.comment_signing_key });
    await volume("maintenance-secrets", { maintenance_database_url: files.maintenance_database_url, accounts: files.accounts });
    const external = Object.entries(volumeNames).map(([name, full]) => `  ${name}:\n    external: true\n    name: ${full}`).join("\n");
    await writeFile(overridePath, `services:
  postgres:
    secrets: !reset []
    volumes:
      - pg-secrets:/run/secrets:ro
  app:
    restart: "no"
    configs: !reset []
    secrets: !reset []
    volumes:
      - manifest:/etc/mq:ro
      - app-secrets:/run/secrets:ro
  proxy:
    restart: "no"
    secrets: !reset []
    environment:
      MQ_TLS_MODE: local
    volumes:
      - proxy-secrets:/run/secrets:ro
    ports: !override ["127.0.0.1:${httpPort}:80", "127.0.0.1:${port}:443"]
  tools:
    configs: !reset []
    volumes:
      - manifest:/etc/mq:ro
    environment:
      MQ_SYNTHETIC_LAB: "true"
volumes:
${external}
`);
    const operation = (name, group, env = {}, action = "scripts/production/database-cli.mjs", extra = [], options = {}) => {
      const args = ["run", "--rm", "--no-deps", "-v", `${volumeNames[group]}:/run/secrets:ro`];
      for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
      return compose([...args, "tools", action, name, ...extra], options);
    };
    const bootstrapEnv = { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url", MQ_ROLE_PASSWORDS_FILE: "/run/secrets/role_passwords" };
    stage = "PG18 private startup and empty database migrations";
    compose(["up", "-d", "--wait", "--wait-timeout", "120", "postgres"]);
    operation("bootstrap", "bootstrap-secrets", bootstrapEnv);
    operation("migrate", "migration-secrets", { MIGRATION_DATABASE_URL_FILE: "/run/secrets/migration_database_url" });
    operation("provision", "bootstrap-secrets", { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url" });
    operation("keys", "key-secrets", { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url",
      MQ_PUBLISH_SIGNING_KEY_FILE: "/run/secrets/publish_signing_key", MQ_COMMENT_SIGNING_KEY_FILE: "/run/secrets/comment_signing_key" });
    operation("audit", "app-secrets", { RUNTIME_DATABASE_URL_FILE: "/run/secrets/database_url" });
    console.log("PASS staging: PG18 empty migrations, five separate login identities and all eleven function owners");
    stage = "private volume ownership and synthetic maintenance initialization";
    compose(["run", "--rm", "--no-deps", "volumes-init"]);
    operation("media-init", "maintenance-secrets", {}, "scripts/production/lab-actions.mjs");
    operation("admin-init", "maintenance-secrets", { MAINTENANCE_DATABASE_URL_FILE: "/run/secrets/maintenance_database_url", MQ_LAB_ACCOUNTS_FILE: "/run/secrets/accounts" }, "scripts/production/lab-actions.mjs");
    stage = "real standalone app and Caddy TLS startup";
    compose(["up", "-d", "--wait", "--wait-timeout", "180", "app", "proxy"]);
    const serviceId = name => compose(["ps", "-q", name]).stdout.trim();
    let ca;
    for (let attempt = 0; attempt < 60; attempt++) {
      const probe = docker(["exec", serviceId("proxy"), "cat", "/data/caddy/pki/authorities/local/root.crt"], { fail: false });
      if (probe.status === 0 && probe.stdout.includes("BEGIN CERTIFICATE")) { ca = probe.stdout; break; }
      await delay(500);
    }
    assert.ok(ca);
    const request = laboratoryTransport(origin, ca, secretValues);
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await request("/api/stories")).status === 200) break; } catch { /* Local TLS initialization only. */ }
      await delay(500);
    }
    for (const name of ["app", "postgres"]) {
      const ports = JSON.parse(docker(["inspect", serviceId(name), "--format", "{{json .HostConfig.PortBindings}}"] ).stdout);
      assert.ok(!ports || Object.keys(ports).length === 0);
    }
    assert.equal(docker(["exec", serviceId("app"), "id", "-u"]).stdout.trim(), "10001");
    const imageEnv = docker(["image", "inspect", images.app, "--format", "{{json .Config.Env}}"] ).stdout;
    assert.ok([...secretValues].every(value => !imageEnv.includes(value)));
    console.log("PASS staging: non-root standalone, only loopback Caddy ports, no runtime secret in image configuration");
    stage = "actual HTTPS business and browser regression";
    const results = await runProductionHttpChecks({ origin, ca, admin: accounts.admin, reader: accounts.reader, secrets: secretValues, evidenceDirectory: evidence,
      restart: async () => {
        compose(["stop", "app"]); compose(["up", "-d", "--force-recreate", "--wait", "postgres"]);
        compose(["up", "-d", "--wait", "--wait-timeout", "180", "app"]);
      },
      directRequest: async () => {
        const result = operation("direct-request", "maintenance-secrets", {}, "scripts/production/lab-actions.mjs");
        return JSON.parse(result.stdout.trim().split("\n").at(-1)).status;
      },
      revoke: async () => { operation("admin-revoke", "maintenance-secrets", { MAINTENANCE_DATABASE_URL_FILE: "/run/secrets/maintenance_database_url" }, "scripts/production/lab-actions.mjs"); },
      ...(operations ? { operations: async fixture => runOperationsLab({ docker, compose, composeBase, project, config, manifest,
        files, passwords, bootstrapUrl, directory, evidence, images, volume, volumeNames, secret, origin, ca, accounts,
        release, temporaryContainers, oss: ossOptions,
        revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
        readVolumeSecret: async (name, file) => volumeEntries[name][file],
      }, fixture) } : {}),
    });
    stage = "startup failure is closed with malformed configuration";
    for (const setting of ["MQ_DEPLOYMENT_ENV=development", "AUTH_SECRET=not-allowed-raw-value"]) {
      const refusal = compose(["run", "--rm", "--no-deps", "-e", setting, "app"], { fail: false, timeout: 30000 });
      assert.equal(refusal.status, 1); assert.match(refusal.stderr, /MQ_STARTUP_REJECTED/);
    }
    console.log("PASS staging: wrong environment and raw-secret configuration cannot start the listener");
    stage = "real low-capacity filesystem refuses startup and media writes";
    const network = `${project}_database`;
    const diskArgs = ["run", "--rm", "--read-only", "--cap-drop", "ALL", "--network", network,
      "--mount", `type=volume,source=${volumeNames.manifest},target=/etc/mq,readonly`,
      "--mount", `type=volume,source=${volumeNames["app-secrets"]},target=/run/secrets,readonly`,
      "--tmpfs", `${mediaRoot}:rw,noexec,nosuid,size=8m,uid=10001,gid=10001,mode=0700`];
    for (const [key, value] of Object.entries({ NODE_ENV: "production", MQ_SYNTHETIC_LAB: "true", MQ_DEPLOYMENT_ENV: "staging",
      MQ_DEPLOYMENT_CONFIG: "/etc/mq/deployment.json", DATABASE_URL_FILE: "/run/secrets/database_url",
      AUTH_SECRET_FILE: "/run/secrets/auth_secret", AUTH_PROXY_SECRET_FILE: "/run/secrets/auth_proxy_secret",
      MQ_PUBLISH_SIGNING_KEY_FILE: "/run/secrets/publish_signing_key", MQ_COMMENT_SIGNING_KEY_FILE: "/run/secrets/comment_signing_key" })) diskArgs.push("-e", `${key}=${value}`);
    docker([...diskArgs, images.tools, "scripts/production/lab-actions.mjs", "disk-refusal"]);
    console.log("PASS staging: actual 8MiB tmpfs refuses media write and startup without filling host storage");
    stage = "redacted container log check";
    const logs = compose(["logs", "--no-color", "app", "proxy", "postgres"]).stdout;
    assert.ok([...secretValues].every(value => !logs.includes(value)));
    assert.ok(!logs.includes("@accounts.invalid"));
    await writeFile(join(evidence, "result.json"), JSON.stringify({ environment: "isolated synthetic staging", checks: results.checks,
      httpPassed: results.passed, screenshots: ["container-desktop.png", "container-mobile.png", "container-admin-desktop.png", "container-admin-mobile.png"],
      credentialsRecorded: false, productionDeployed: false }, null, 2));
    console.log(`PASS staging container laboratory; evidence=${evidence}`); succeeded = true;
  } finally {
    // Exact generated project only. Preserve failed lab volumes for diagnosis;
    // never prune, delete unknown files, or run compose down -v.
    if (await readFile(overridePath).then(() => true, () => false)) compose(["down", "--remove-orphans"], { fail: false });
    for (const container of temporaryContainers) docker(["rm", "-f", container], { fail: false });
    if (ossOptions) {
      try { removeRealOssSecret({ docker, project, volumeNames }, ossOptions); }
      catch {
        console.error("OSS_TEMP_SECRET_CLEANUP_FAILED; inspect this run's labelled secret volume");
        process.exitCode = 1; succeeded = false;
      }
    }
    if (ossOptions?.network) docker(["network", "rm", ossOptions.network], { fail: false });
    if (succeeded) {
      const volumes = docker(["volume", "ls", "--filter", `name=${project}`, "--format", "{{.Name}}" ]).stdout.trim().split(/\r?\n/).filter(Boolean);
      for (const name of volumes) {
        assert.ok(name.startsWith(`${project}_`)); docker(["volume", "rm", name]);
      }
    }
    // Host temporary files include synthetic secrets. No path is uploaded; the
    // owner may retain failed evidence locally and remove the exact lab directory.
  }
}

try { await main(); }
catch (error) {
  const detail = /^STAGING_HTTP_FAILED:[a-z /,-]+$/.test(error.message) ? ` (${error.message})` : "";
  console.error(`PRODUCTION_LAB_FAILED at ${stage}${detail}; private command output withheld`); process.exitCode = 1;
}
