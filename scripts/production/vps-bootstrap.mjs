import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, writeFile, readFile, realpath, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { verifyReleaseBundle, releaseCompatibility, TARGETS } from "../release/bundle.mjs";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "./database-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const reserve = 8 * 1024 ** 3;
const labPattern = /^\/srv\/mq-labs\/p501-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;

// Fixed, nonsecret progress only. The native installer accepts an explicit
// allowlist of these markers instead of printing Docker/SQL diagnostics.
function phase(name) { process.stderr.write(`VPS_LAB_PHASE=${name}\n`); }

export function validateBootstrapTarget({ directory, httpPort, httpsPort }) {
  const match = labPattern.exec(directory ?? "");
  assert.ok(match, "VPS_LAB_TARGET_REJECTED");
  for (const port of [httpPort, httpsPort]) assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, "VPS_LAB_PORT_REJECTED");
  assert.notEqual(httpPort, httpsPort, "VPS_LAB_PORT_REJECTED");
  return { directory, httpPort, httpsPort, id: match[1], project: `mq-p501-${match[1].replaceAll("-", "")}` };
}

export function dockerCommand(args, { fail = true, timeout = 300000, input } = {}) {
  const result = spawnSync("docker", args, { cwd: root, encoding: "utf8", input, timeout, maxBuffer: 8 * 1024 ** 2 });
  // Docker failures may contain secret-bearing inspect data. Never echo stderr,
  // command arguments or arbitrary error objects; callers receive a fixed code.
  if (fail && (result.error || result.status !== 0)) throw new Error("VPS_LAB_DOCKER_FAILED");
  return result;
}

async function requirePrivateDirectory(directory) {
  assert.equal(process.platform, "linux", "VPS_LAB_LINUX_REQUIRED");
  assert.equal(process.getuid(), 0, "VPS_LAB_ROOT_REQUIRED");
  assert.equal(await realpath(directory), directory, "VPS_LAB_PATH_REJECTED");
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && info.uid === 0 && (info.mode & 0o7777) === 0o700, "VPS_LAB_DIRECTORY_REJECTED");
}

async function diskSpace(path, additional = 0) {
  const space = await statfs(path);
  assert.ok(space.bavail * space.bsize >= reserve + additional, "VPS_LAB_DISK_RESERVE_LOW");
  assert.ok(space.files === 0 || space.ffree / space.files >= 0.05, "VPS_LAB_INODES_LOW");
}

export function assertIsolatedCompose(spec, state) {
  assert.equal(spec.name, state.project, "VPS_LAB_COMPOSE_TARGET_REJECTED");
  assert.deepEqual(Object.keys(spec.services).filter(name => spec.services[name].ports?.length), ["proxy"], "VPS_LAB_PORT_EXPOSED");
  const ports = spec.services.proxy.ports.map(port => ({ ip: port.host_ip, published: Number(port.published), target: port.target })).sort((a, b) => a.target - b.target);
  assert.deepEqual(ports, [{ ip: "127.0.0.1", published: state.httpPort, target: 80 }, { ip: "127.0.0.1", published: state.httpsPort, target: 443 }], "VPS_LAB_PORT_EXPOSED");
  for (const name of ["app", "tools", "proxy"]) {
    assert.equal(spec.services[name].image, state.images[name], "VPS_LAB_IMAGE_REJECTED");
    assert.equal(spec.services[name].user, "10001:10001", "VPS_LAB_USER_REJECTED");
    assert.equal(spec.services[name].read_only, true, "VPS_LAB_READONLY_REQUIRED");
  }
  assert.match(spec.services.postgres.image, /^postgres:18\.[^@]+@sha256:[a-f0-9]{64}$/, "VPS_LAB_POSTGRES_REJECTED");
  for (const name of ["frontend", "database"]) assert.equal(spec.networks[name].internal, true, "VPS_LAB_NETWORK_REJECTED");
  assert.equal(spec.services.app.environment.MQ_DEPLOYMENT_ENV, "staging");
  assert.equal(spec.services.proxy.environment.MQ_TLS_MODE, "local");
  assert.equal(spec.services.app.environment.AUTH_ORIGIN, state.manifest.origin);
  // Compose's JSON encoder may serialize byte quantities as decimal strings.
  assert.equal(Number(spec.services.app.mem_limit), 1536 * 1024 ** 2);
  assert.equal(Number(spec.services.postgres.mem_limit), 768 * 1024 ** 2);
}

function makeContext(state, docker = dockerCommand) {
  const { directory, project } = state;
  const save = () => writeFile(join(directory, "state.json"), JSON.stringify(state), { mode: 0o600 });
  const composeBase = ["compose", "--env-file", join(directory, "compose.env"), "--project-name", project,
    "-f", join(root, "compose.production.yaml"), "-f", join(directory, "lab.yaml")];
  const compose = (args, options) => docker([...composeBase, ...args], options);
  const context = { ...state, docker, compose, composeBase, config: validateDeploymentConfig(state.manifest),
    origin: state.manifest.origin, save, state,
    readVolumeSecret: async (name, file) => state.volumeEntries[name][file],
    serviceId: name => {
      assert.ok(["app", "postgres", "proxy"].includes(name));
      const id = compose(["ps", "--all", "--quiet", name]).stdout.trim();
      assert.match(id, /^[a-f0-9]{64}$/); return id;
    },
    operation: (name, group, env = {}, action = "scripts/production/database-cli.mjs", extra = [], options = {}) => {
      assert.ok(state.volumeNames[group], "VPS_LAB_SECRET_GROUP_REJECTED");
      assert.match(action, /^scripts\/production\/[a-z-]+\.mjs$/);
      const args = ["run", "--rm", "--no-deps", "-v", `${state.volumeNames[group]}:/run/secrets:ro`];
      for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
      return compose([...args, "tools", action, name, ...extra], options);
    },
    secret: () => randomBytes(32).toString("hex"),
  };
  context.volume = async (name, entries = {}, uid = 10001) => {
    assert.match(name, /^[a-z][a-z-]*$/);
    assert.ok([999, 10001].includes(uid));
    for (const [file, value] of Object.entries(entries)) {
      assert.match(file, /^[a-z][a-z0-9_.-]*$/); assert.equal(typeof value, "string");
    }
    const full = `${project}_${name}`;
    const found = docker(["volume", "inspect", full], { fail: false });
    if (found.status === 0) {
      assert.equal(state.volumeNames[name], full, "VPS_LAB_UNKNOWN_VOLUME");
      assert.equal(JSON.parse(found.stdout)[0].Labels?.["mq.lab"], state.id, "VPS_LAB_UNKNOWN_VOLUME");
    } else docker(["volume", "create", "--label", `mq.lab=${state.id}`, full]);
    state.volumeNames[name] = full; state.volumeEntries[name] = entries; await save();
    const staged = join(directory, `stage-${name}-${randomBytes(6).toString("hex")}`);
    await mkdir(staged, { mode: 0o700 });
    for (const [file, value] of Object.entries(entries)) await writeFile(join(staged, file), value, { flag: "wx", mode: 0o600 });
    const helper = `${project}-init-${name}-${randomBytes(6).toString("hex")}`;
    docker(["create", "--name", helper, "--label", `mq.lab=${state.id}`, "--network", "none", "--user", "0:0",
      "--memory", "64m", "--cpus", "0.25", "--pids-limit", "32", "--mount", `type=volume,source=${full},target=/target`,
      "--mount", "type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=1048576", "--entrypoint", "/bin/sh", state.images.tools,
      "-eu", "-c", `cp -R /staged/. /target/ && chown -R ${uid}:${uid} /target && chmod 0700 /target && find /target -type f -exec chmod ${name.endsWith("manifest") ? "0444" : "0400"} {} +`]);
    docker(["cp", `${staged}/.`, `${helper}:/staged`]);
    docker(["start", "--attach", helper]); docker(["rm", helper]);
    return full;
  };
  return context;
}

/** Read private synthetic state only from this explicit root-owned lab. Never
 * serialize this returned context to a terminal or an uploaded artifact. */
export async function loadLab(directory, docker = dockerCommand) {
  const match = labPattern.exec(directory ?? ""); assert.ok(match, "VPS_LAB_TARGET_REJECTED");
  await requirePrivateDirectory(directory);
  const info = await lstat(join(directory, "state.json"));
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && info.nlink === 1 && (info.mode & 0o7777) === 0o600);
  const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  const target = validateBootstrapTarget(state);
  assert.equal(state.directory, directory); assert.equal(state.id, target.id); assert.equal(state.project, target.project);
  assert.equal(state.manifest.environment, "staging");
  assert.equal(state.manifest.database.name, `mq_staging_${state.id.replaceAll("-", "")}`);
  assert.equal(state.manifest.origin, `https://mq.localhost:${state.httpsPort}`);
  for (const name of TARGETS) assert.match(state.images[name], /^sha256:[a-f0-9]{64}$/);
  return makeContext(state, docker);
}

export async function initializeLab(ctx, health) {
  const { compose, operation } = ctx;
  try {
    phase("postgres-start");
    compose(["up", "-d", "--wait", "--wait-timeout", "180", "postgres"]);
    phase("database-bootstrap");
    operation("bootstrap", "bootstrap-secrets", { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url", MQ_ROLE_PASSWORDS_FILE: "/run/secrets/role_passwords" });
    phase("database-migrate");
    operation("migrate", "migration-secrets", { MIGRATION_DATABASE_URL_FILE: "/run/secrets/migration_database_url" });
    phase("database-provision");
    operation("provision", "bootstrap-secrets", { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url" });
    phase("signing-init");
    operation("keys", "key-secrets", { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url",
      MQ_PUBLISH_SIGNING_KEY_FILE: "/run/secrets/publish_signing_key", MQ_COMMENT_SIGNING_KEY_FILE: "/run/secrets/comment_signing_key" });
    phase("runtime-audit");
    operation("audit", "app-secrets", { RUNTIME_DATABASE_URL_FILE: "/run/secrets/database_url" });
    phase("volumes-init");
    compose(["run", "--rm", "--no-deps", "volumes-init"]);
    phase("media-init");
    operation("media-init", "maintenance-secrets", {}, "scripts/production/lab-actions.mjs");
    phase("synthetic-admin-init");
    operation("admin-init", "maintenance-secrets", { MAINTENANCE_DATABASE_URL_FILE: "/run/secrets/maintenance_database_url", MQ_LAB_ACCOUNTS_FILE: "/run/secrets/accounts" }, "scripts/production/lab-actions.mjs");
    phase("app-proxy-start");
    compose(["up", "-d", "--wait", "--wait-timeout", "180", "app", "proxy"]);
    phase("https-check");
    assert.equal(await health(ctx), true, "VPS_LAB_HEALTH_FAILED");
  } catch {
    const stopped = await Promise.allSettled(["proxy", "app"].map(async name => compose(["stop", name])));
    if (stopped.some(result => result.status === "rejected")) throw new Error("VPS_LAB_FAILED_CONTAINMENT_UNCONFIRMED");
    throw new Error("VPS_LAB_FAILED_INGRESS_CLOSED");
  }
}

async function healthyHttps(ctx) {
  let ca;
  for (let attempt = 0; attempt < 40; attempt++) {
    const read = ctx.docker(["exec", ctx.serviceId("proxy"), "cat", "/data/caddy/pki/authorities/local/root.crt"], { fail: false });
    if (read.status === 0 && read.stdout.includes("BEGIN CERTIFICATE")) { ca = read.stdout; break; }
    await delay(500);
  }
  assert.ok(ca, "VPS_LAB_CA_MISSING");
  await writeFile(join(ctx.directory, "local-ca.pem"), ca, { flag: "wx", mode: 0o600 });
  const code = await new Promise((done, reject) => {
    const request = https.get({ hostname: "127.0.0.1", port: ctx.httpsPort, servername: "mq.localhost", ca,
      path: "/api/stories", headers: { host: `mq.localhost:${ctx.httpsPort}` }, timeout: 15000 }, response => { response.resume(); done(response.statusCode); });
    request.on("error", reject); request.on("timeout", () => request.destroy(new Error("VPS_LAB_HTTPS_TIMEOUT")));
  });
  for (const name of ["app", "postgres"]) {
    const actual = JSON.parse(ctx.docker(["inspect", ctx.serviceId(name), "--format", "{{json .HostConfig.PortBindings}}"] ).stdout);
    assert.ok(!actual || Object.keys(actual).length === 0, "VPS_LAB_PORT_EXPOSED");
  }
  return code === 200;
}

export async function bootstrapVpsLab(input, { docker = dockerCommand, verify = verifyReleaseBundle } = {}) {
  phase("validate-target");
  const target = validateBootstrapTarget(input);
  assert.equal(process.platform, "linux", "VPS_LAB_LINUX_REQUIRED"); assert.equal(process.getuid(), 0, "VPS_LAB_ROOT_REQUIRED");
  const parent = dirname(target.directory);
  await requirePrivateDirectory(parent);
  // mkdir without recursive/overwrite is the first write. An existing lab is
  // never adopted, reset or silently initialized a second time.
  phase("verify-release");
  const release = await verify(resolve(input.candidate), input.manifestSha256);
  assert.deepEqual(await releaseCompatibility(root), release.compatibility, "VPS_LAB_SOURCE_CONTRACT_MISMATCH");
  phase("validate-host");
  const info = JSON.parse(docker(["info", "--format", "{{json .}}"] ).stdout);
  assert.equal(info.OSType, "linux"); assert.ok(["x86_64", "amd64"].includes(info.Architecture));
  assert.ok(info.DriverStatus.some(row => row.includes("io.containerd.snapshotter.v1")), "VPS_LAB_CONTAINERD_REQUIRED");
  const archiveBytes = Object.values(release.images).reduce((sum, image) => sum + image.archiveBytes, 0);
  await diskSpace(parent); await diskSpace(info.DockerRootDir, archiveBytes * 2);
  for (const [kind, filter] of [["ps", `label=com.docker.compose.project=${target.project}`], ["volume", `name=${target.project}`], ["network", `name=${target.project}`]]) {
    const args = kind === "ps" ? ["ps", "-aq", "--filter", filter] : [kind, "ls", "-q", "--filter", filter];
    assert.equal(docker(args).stdout.trim(), "", "VPS_LAB_EXISTING_TARGET_REJECTED");
  }
  for (const port of [target.httpPort, target.httpsPort]) {
    const server = createServer();
    await new Promise((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
    await new Promise(done => server.close(done));
  }
  await mkdir(target.directory, { mode: 0o700 });
  const images = {};
  for (const name of TARGETS) {
    phase(`load-${name}`);
    docker(["image", "load", "--input", join(resolve(input.candidate), release.images[name].file)], { timeout: 600000 });
    const descriptor = JSON.parse(docker(["image", "inspect", `mq-release-${name}:${release.sourceSha}`, "--format", "{{json .Descriptor}}"] ).stdout);
    assert.equal(descriptor.digest, release.images[name].indexDigest, "VPS_LAB_LOADED_DIGEST_MISMATCH");
    images[name] = descriptor.digest; await diskSpace(info.DockerRootDir);
  }
  const manifest = { version: 1, environment: "staging", deploymentId: target.id,
    database: { host: "postgres", port: 5432, name: `mq_staging_${target.id.replaceAll("-", "")}` },
    origin: `https://mq.localhost:${target.httpsPort}`, media: { root: "/var/lib/mq/media", minFreeBytes: reserve } };
  const config = validateDeploymentConfig(manifest), secret = () => randomBytes(32).toString("hex");
  const passwords = Object.fromEntries(LOGIN_IDENTITIES.map(name => [name, secret()])), bootstrapPassword = secret();
  const url = (role, password) => `postgresql://${role}:${password}@postgres:5432/${manifest.database.name}`;
  const bootstrapUrl = url("mq_bootstrap", bootstrapPassword);
  const accounts = { admin: { username: `lab_admin_${target.id.replaceAll("-", "").slice(0, 8)}`, password: `MqLab!${secret()}` },
    reader: { username: `lab_reader_${target.id.replaceAll("-", "").slice(0, 8)}`, password: `MqReader!${secret()}` } };
  const files = { postgres_password: bootstrapPassword, database_url: url(config.roles.runtime, passwords.runtime),
    auth_secret: secret(), session_storage_key: secret(), auth_proxy_secret: secret(), publish_signing_key: secret(), comment_signing_key: secret(),
    bootstrap_database_url: bootstrapUrl, migration_database_url: url(config.roles.migration, passwords.migration),
    maintenance_database_url: url(config.roles.maintenance, passwords.maintenance), role_passwords: JSON.stringify(passwords), accounts: JSON.stringify(accounts) };
  const state = { version: 1, ...target, sourceSha: release.sourceSha, images, manifest, accounts, files, passwords, bootstrapUrl,
    volumeNames: {}, volumeEntries: {}, phase: "preparing" };
  const ctx = makeContext(state, docker); await ctx.save();
  try {
  phase("prepare-files");
  await writeFile(join(target.directory, "deployment.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o444 });
  await mkdir(join(target.directory, "unused-file-secrets"), { mode: 0o700 });
  for (const name of ["postgres_password", "database_url", "auth_secret", "session_storage_key", "auth_proxy_secret", "publish_signing_key", "comment_signing_key"])
    await writeFile(join(target.directory, "unused-file-secrets", name), "unused: named-volume override required\n", { flag: "wx", mode: 0o600 });
  const environment = { MQ_DEPLOYMENT_ENV: "staging", MQ_DATABASE_NAME: manifest.database.name, MQ_AUTH_ORIGIN: manifest.origin,
    MQ_PUBLIC_HOST: "mq.localhost", MQ_DEPLOYMENT_CONFIG: join(target.directory, "deployment.json"), MQ_SECRET_DIRECTORY: join(target.directory, "unused-file-secrets"),
    MQ_APP_IMAGE: images.app, MQ_TOOLS_IMAGE: images.tools, MQ_PROXY_IMAGE: images.proxy,
    MQ_AUTH_ENABLED: "true", MQ_MEDIA_ENABLED: "true", MQ_PUBLISH_ENABLED: "true", MQ_COMMENTS_ENABLED: "true" };
  await writeFile(join(target.directory, "compose.env"), Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n"), { flag: "wx", mode: 0o600 });
  phase("prepare-volumes");
  for (const [name, entries, uid] of [
    ["manifest", { "deployment.json": JSON.stringify(manifest) }, 10001],
    ["app-secrets", Object.fromEntries(["database_url", "auth_secret", "session_storage_key", "auth_proxy_secret", "publish_signing_key", "comment_signing_key"].map(name => [name, files[name]])), 10001],
    ["pg-secrets", { postgres_password: files.postgres_password }, 999], ["proxy-secrets", { auth_proxy_secret: files.auth_proxy_secret }, 10001],
    ["bootstrap-secrets", { bootstrap_database_url: bootstrapUrl, role_passwords: files.role_passwords }, 10001],
    ["migration-secrets", { migration_database_url: files.migration_database_url }, 10001],
    ["key-secrets", { bootstrap_database_url: bootstrapUrl, publish_signing_key: files.publish_signing_key, comment_signing_key: files.comment_signing_key }, 10001],
    ["maintenance-secrets", { maintenance_database_url: files.maintenance_database_url, accounts: files.accounts }, 10001],
  ]) await ctx.volume(name, entries, uid);
  const external = Object.entries(state.volumeNames).map(([name, full]) => `  ${name}:\n    external: true\n    name: ${full}`).join("\n");
  await writeFile(join(target.directory, "lab.yaml"), `services:
  postgres:
    secrets: !reset []
    volumes: [pg-secrets:/run/secrets:ro]
  app:
    configs: !reset []
    secrets: !reset []
    volumes: [manifest:/etc/mq:ro, app-secrets:/run/secrets:ro]
  proxy:
    secrets: !reset []
    environment: { MQ_TLS_MODE: local }
    volumes: [proxy-secrets:/run/secrets:ro]
    ports: !override ["127.0.0.1:${target.httpPort}:80", "127.0.0.1:${target.httpsPort}:443"]
  tools:
    configs: !reset []
    volumes: [manifest:/etc/mq:ro]
    environment: { MQ_SYNTHETIC_LAB: "true" }
volumes:
${external}
${["database", "media", "caddy-data", "caddy-config"].map(name => `  ${name}:\n    labels: { mq.lab: "${target.id}" }`).join("\n")}
`, { flag: "wx", mode: 0o600 });
  phase("validate-compose");
  assertIsolatedCompose(JSON.parse(ctx.compose(["--profile", "maintenance", "config", "--format", "json"]).stdout), state);
  state.phase = "initializing"; await ctx.save();
  await initializeLab(ctx, healthyHttps);
  await diskSpace(info.DockerRootDir); await diskSpace(target.directory);
  state.phase = "healthy"; await ctx.save();
  phase("write-receipt");
  const receipt = { version: 1, synthetic: true, productionDeployed: false, ...target, sourceSha: release.sourceSha,
    manifestSha256: input.manifestSha256, images, volumeNames: state.volumeNames, composeBase: ctx.composeBase,
    origin: manifest.origin, caPath: join(target.directory, "local-ca.pem"), completedAt: new Date().toISOString() };
  await writeFile(join(target.directory, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
  return receipt;
  } catch {
    const configured = await lstat(join(target.directory, "lab.yaml")).then(() => true, () => false);
    let contained = true;
    if (configured) {
      const stopped = await Promise.allSettled(["proxy", "app"].map(async name => ctx.compose(["stop", name])));
      contained = stopped.every(result => result.status === "fulfilled");
    }
    state.phase = "failed";
    // A full disk must not stop ingress containment. Keep the last private
    // checkpoint if this diagnostic write itself cannot complete.
    await Promise.allSettled([ctx.save()]);
    if (!contained) throw new Error("VPS_LAB_FAILED_CONTAINMENT_UNCONFIRMED");
    throw new Error("VPS_LAB_FAILED_INGRESS_CLOSED");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [candidate, manifestSha256, directory, http, httpsPort, ...extra] = process.argv.slice(2);
    assert.equal(extra.length, 0);
    const result = await bootstrapVpsLab({ candidate, manifestSha256, directory, httpPort: Number(http), httpsPort: Number(httpsPort) });
    console.log(JSON.stringify(result));
  } catch { console.error("VPS_STAGING_BOOTSTRAP_FAILED; inspect private state locally; no production deployment"); process.exitCode = 1; }
}
