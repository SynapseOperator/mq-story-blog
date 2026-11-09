import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { lstat, realpath, readFile, writeFile, mkdir, rename, statfs, chown, open } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { TextDecoder } from "node:util";
import https from "node:https";
import { checkServerIdentity } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { readDeploymentFile, readDeploymentManifest } from "../production/runtime-config.mjs";
import { readBackupReceipt } from "../production/backup-window.mjs";
import { claimProductionOperation } from "../production/operation-lock.mjs";
import { assertDatabaseUrl, LOGIN_IDENTITIES } from "../production/database-config.mjs";
import { verifyReleaseBundle, releaseCompatibility, TARGETS, sha256 } from "./bundle.mjs";
import { planProductionBootstrap, planProductionChange, planProductionActivation, planProductionPrivatePreview,
  planProductionPreviewClose, validatePrivatePreview, executeProductionPlan } from "./production-plan.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
const reserve = 8 * 1024 ** 3;
const secretOwners = { postgres_password: 999, database_url: 10001, auth_secret: 10001, session_storage_key: 10001,
  auth_proxy_secret: 10001, publish_signing_key: 10001, comment_signing_key: 10001,
  bootstrap_database_url: 10001, migration_database_url: 10001, role_passwords: 10001 };

function docker(args, { fail = true, timeout = 300000 } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 ** 2 });
  if (fail && (result.error || result.status !== 0)) throw new Error("PRODUCTION_DOCKER_FAILED");
  return result;
}

export function validateHostSettings(value, config) {
  const keys = ["approvalFile", "candidateDirectory", "candidateManifestSha256", "deploymentFile", "features", "gateFile", "secretDirectory", "targetDirectory", "version"];
  if (Object.hasOwn(value, "preview")) { validatePrivatePreview(value.preview); keys.push("preview"); }
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
  assert.equal(value.version, 1);
  assert.equal(config.environment, "production");
  assert.equal(value.targetDirectory, `/srv/mq-production/${config.deploymentId}`);
  assert.deepEqual(Object.keys(value.features).sort(), ["auth", "comments", "media", "publishing"]);
  for (const enabled of Object.values(value.features)) assert.equal(typeof enabled, "boolean");
  for (const name of ["approvalFile", "candidateDirectory", "deploymentFile", "gateFile", "secretDirectory"])
    assert.ok(typeof value[name] === "string" && /^\/[A-Za-z0-9_./-]+$/.test(value[name]) && posix.normalize(value[name]) === value[name]);
  assert.match(value.candidateManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(config.database.host, "postgres"); assert.equal(config.database.port, 5432);
  assert.equal(config.media.root, "/var/lib/mq/media");
  assert.ok(config.media.minFreeBytes >= reserve);
  return value;
}

export async function readPrivatePreviewFiles(preview, origin, now = Date.now()) {
  validatePrivatePreview(preview);
  const files = {};
  for (const name of ["ca", "certificate", "privateKey"]) {
    const { path, sha256: expected } = preview[name];
    await privateDirectory(dirname(path));
    assert.equal(await realpath(path), path, "PRODUCTION_PREVIEW_FILE_REJECTED");
    const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const info = await file.stat();
      assert.ok(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 16384,
        "PRODUCTION_PREVIEW_FILE_REJECTED");
      if (process.platform !== "win32") assert.ok(info.uid === 10001 && [0o400, 0o600].includes(info.mode & 0o7777),
        "PRODUCTION_PREVIEW_FILE_REJECTED");
      files[name] = await file.readFile();
      assert.equal(sha256(files[name]), expected, "PRODUCTION_PREVIEW_FILE_CHANGED");
    } finally { await file.close(); }
  }
  const ca = new X509Certificate(files.ca), certificate = new X509Certificate(files.certificate);
  assert.ok(ca.ca && ca.verify(ca.publicKey) && !certificate.ca && certificate.verify(ca.publicKey), "PRODUCTION_PREVIEW_CA_REJECTED");
  const hostname = new URL(origin).hostname;
  assert.equal(certificate.checkHost(hostname, { subject: "never", wildcards: false }), hostname, "PRODUCTION_PREVIEW_HOSTNAME_REJECTED");
  assert.ok(certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.1"), "PRODUCTION_PREVIEW_SERVER_CERTIFICATE_REQUIRED");
  assert.ok(certificate.checkPrivateKey(createPrivateKey(files.privateKey)), "PRODUCTION_PREVIEW_KEY_REJECTED");
  for (const cert of [ca, certificate]) assert.ok(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo),
    "PRODUCTION_PREVIEW_CERTIFICATE_EXPIRED");
  return { ca: files.ca };
}

export function validateCurrentReleaseGate(gate, sourceSha, now = Date.now()) {
  assert.equal(gate.kind, "reviewed-main", "PRODUCTION_CURRENT_REVIEW_REQUIRED");
  assert.equal(gate.repository, "SynapseOperator/mq-story-blog", "PRODUCTION_CURRENT_REVIEW_REQUIRED");
  assert.equal(gate.sourceSha, sourceSha, "PRODUCTION_CURRENT_REVIEW_REQUIRED");
  for (const key of ["sourceSha", "observedMainSha", "reviewedHead"]) assert.match(gate[key], /^[a-f0-9]{40}$/);
  assert.equal(gate.reviewer, "SnorkelingBreather", "PRODUCTION_CURRENT_REVIEW_REQUIRED");
  for (const key of ["pullRequest", "reviewId", "qualityRunId"]) assert.ok(Number.isSafeInteger(gate[key]) && gate[key] > 0);
  const checked = Date.parse(gate.checkedAt);
  assert.ok(Number.isFinite(checked) && checked <= now && now - checked <= 60 * 60 * 1000, "PRODUCTION_CURRENT_REVIEW_EXPIRED");
}

async function privateDirectory(path) {
  assert.equal(await realpath(path), path, "PRODUCTION_PATH_REJECTED");
  const info = await lstat(path);
  assert.ok(info.isDirectory(), "PRODUCTION_PRIVATE_DIRECTORY_REQUIRED");
  if (process.platform !== "win32") assert.ok(info.uid === 0 && (info.mode & 0o7777) === 0o700, "PRODUCTION_PRIVATE_DIRECTORY_REQUIRED");
}

export function assertPrivateDockerRouting(args, config) {
  assert.ok(Array.isArray(args) && args.every(value => typeof value === "string"), "PRODUCTION_PREVIEW_ROUTING_REJECTED");
  assert.ok(config && typeof config === "object" && !Array.isArray(config), "PRODUCTION_PREVIEW_ROUTING_REJECTED");
  assert.ok(config["allow-direct-routing"] === undefined || config["allow-direct-routing"] === false,
    "PRODUCTION_PREVIEW_ROUTING_REJECTED");
  // Loopback publication relies on Docker's bridge filtering. With its firewall
  // disabled, a routed peer can reach the container IP instead of the host port.
  assert.ok(config.iptables === undefined || config.iptables === true, "PRODUCTION_PREVIEW_FIREWALL_REQUIRED");
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value.startsWith("--allow-direct-routing=")) assert.equal(value, "--allow-direct-routing=false", "PRODUCTION_PREVIEW_ROUTING_REJECTED");
    if (value === "--allow-direct-routing") assert.equal(args[index + 1], "false", "PRODUCTION_PREVIEW_ROUTING_REJECTED");
    if (value.startsWith("--iptables=")) assert.equal(value, "--iptables=true", "PRODUCTION_PREVIEW_FIREWALL_REQUIRED");
    if (value === "--iptables" && args[index + 1] === "false") assert.fail("PRODUCTION_PREVIEW_FIREWALL_REQUIRED");
  }
}

async function privateDockerRouting() {
  assert.ok(!process.env.DOCKER_HOST || process.env.DOCKER_HOST === "unix:///var/run/docker.sock", "PRODUCTION_PREVIEW_LOCAL_DOCKER_REQUIRED");
  const endpoint = JSON.parse(docker(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"] ).stdout);
  assert.equal(endpoint, "unix:///var/run/docker.sock", "PRODUCTION_PREVIEW_LOCAL_DOCKER_REQUIRED");
  const pid = (await readFile("/run/docker.pid", "utf8")).trim();
  assert.match(pid, /^[1-9][0-9]{0,9}$/, "PRODUCTION_PREVIEW_DOCKER_PID_REQUIRED");
  assert.equal((await readFile(`/proc/${pid}/comm`, "utf8")).trim(), "dockerd", "PRODUCTION_PREVIEW_DOCKER_PID_REQUIRED");
  const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  const explicit = args.flatMap((value, index) => value.startsWith("--config-file=") ? [value.slice(14)]
    : value === "--config-file" ? [args[index + 1]] : []);
  assert.ok(explicit.length <= 1, "PRODUCTION_PREVIEW_ROUTING_REJECTED");
  const path = explicit[0] ?? "/etc/docker/daemon.json";
  assert.ok(typeof path === "string" && path.startsWith("/") && posix.normalize(path) === path, "PRODUCTION_PREVIEW_ROUTING_REJECTED");
  let config = {};
  try {
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022) && info.size <= 65536,
      "PRODUCTION_PREVIEW_ROUTING_REJECTED");
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || explicit.length) throw error;
  }
  assertPrivateDockerRouting(args, config);
  return true;
}

export function assertPrivateProxyNetworks(networks, { allowMissingEdge = false } = {}) {
  const expected = allowMissingEdge && networks.length === 1 ? ["mq-production_frontend"] : ["mq-production_edge", "mq-production_frontend"];
  assert.deepEqual(networks.map(network => network.Name).sort(), expected, "PRODUCTION_PREVIEW_NETWORK_REJECTED");
  for (const network of networks) {
    assert.equal(network.Driver, "bridge", "PRODUCTION_PREVIEW_NETWORK_REJECTED");
    assert.equal(network.EnableIPv6, false, "PRODUCTION_PREVIEW_NETWORK_REJECTED");
    assert.equal(network.Labels["com.docker.compose.project"], "mq-production", "PRODUCTION_PREVIEW_NETWORK_REJECTED");
    assert.equal(network.Internal, network.Name === "mq-production_frontend", "PRODUCTION_PREVIEW_NETWORK_REJECTED");
    for (const family of ["ipv4", "ipv6"]) assert.ok([undefined, "nat"].includes(network.Options?.[`com.docker.network.bridge.gateway_mode_${family}`]),
      "PRODUCTION_PREVIEW_NETWORK_REJECTED");
    assert.ok(!network.Options?.["com.docker.network.bridge.trusted_host_interfaces"], "PRODUCTION_PREVIEW_NETWORK_REJECTED");
  }
}

export async function readSecrets(directory, config) {
  await privateDirectory(directory);
  const values = {};
  for (const [name, uid] of Object.entries(secretOwners)) {
    const path = join(directory, name), info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === uid
      && [0o400, 0o600].includes(info.mode & 0o7777) && info.size > 0 && info.size <= 4096, "PRODUCTION_SECRET_FILE_REJECTED");
    values[name] = (await readFile(path, "utf8")).replace(/\r?\n$/, "");
  }
  for (const [file, identity] of [["database_url", "runtime"], ["bootstrap_database_url", "bootstrap"], ["migration_database_url", "migration"]])
    assertDatabaseUrl(values[file], config, identity);
  const passwords = JSON.parse(values.role_passwords);
  assert.deepEqual(Object.keys(passwords).sort(), [...LOGIN_IDENTITIES].sort());
  for (const password of Object.values(passwords)) assert.match(password, /^[A-Za-z0-9_-]{32,128}$/);
  assert.match(values.postgres_password, /^[A-Za-z0-9_-]{32,128}$/, "PRODUCTION_BOOTSTRAP_PASSWORD_REJECTED");
  const bootstrap = new URL(values.bootstrap_database_url);
  assert.equal(decodeURIComponent(bootstrap.username), "mq_bootstrap");
  assert.equal(decodeURIComponent(bootstrap.password), values.postgres_password);
  assert.equal(decodeURIComponent(new URL(values.database_url).password), passwords.runtime);
  assert.equal(decodeURIComponent(new URL(values.migration_database_url).password), passwords.migration);
  const keys = ["auth_secret", "session_storage_key", "auth_proxy_secret", "publish_signing_key", "comment_signing_key"].map(name => values[name]);
  for (const key of keys) assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(new Set([...Object.values(passwords), values.postgres_password, ...keys]).size, LOGIN_IDENTITIES.length + 1 + keys.length,
    "PRODUCTION_SECRET_REUSE_REJECTED");
  // Contents never enter state, Docker argv, output, or the approval record.
}

export function assertProductionCompose(spec, { images, config, openIngress = false, preview }) {
  assert.equal(spec.name, "mq-production");
  for (const name of ["app", "tools", "proxy"]) {
    assert.equal(spec.services[name].image, images[name]);
    assert.equal(spec.services[name].user, "10001:10001");
    assert.equal(spec.services[name].read_only, true);
    assert.ok(!spec.services[name].privileged && !spec.services[name].network_mode);
  }
  assert.match(spec.services.postgres.image, /^postgres:18\.[^@]+@sha256:[a-f0-9]{64}$/);
  assert.ok(!openIngress || !preview, "PRODUCTION_INGRESS_MODE_REJECTED");
  assert.deepEqual(Object.keys(spec.services).filter(name => spec.services[name].ports?.length), openIngress || preview ? ["proxy"] : []);
  if (openIngress) assert.deepEqual(spec.services.proxy.ports.map(p => [Number(p.published), Number(p.target)]).sort((a,b)=>a[0]-b[0]), [[80,80],[443,443]]);
  if (preview) {
    validatePrivatePreview(preview);
    assert.deepEqual(spec.services.proxy.ports.map(p => [p.host_ip, Number(p.published), Number(p.target), p.protocol]),
      [["127.0.0.1", preview.port, 443, "tcp"]], "PRODUCTION_PREVIEW_LOOPBACK_REQUIRED");
    assert.deepEqual(spec.services.proxy.secrets.map(item => [item.source, item.target]).sort(),
      [["auth_proxy_secret", "/run/secrets/auth_proxy_secret"], ["preview_certificate", "/run/secrets/preview_certificate"], ["preview_private_key", "/run/secrets/preview_private_key"]],
      "PRODUCTION_PREVIEW_MOUNTS_REJECTED");
    assert.equal(spec.secrets.preview_certificate.file, preview.certificate.path, "PRODUCTION_PREVIEW_MOUNTS_REJECTED");
    assert.equal(spec.secrets.preview_private_key.file, preview.privateKey.path, "PRODUCTION_PREVIEW_MOUNTS_REJECTED");
  }
  for (const name of ["frontend", "database"]) assert.equal(spec.networks[name].internal, true);
  assert.equal(spec.services.app.environment.MQ_DEPLOYMENT_ENV, "production");
  assert.equal(spec.services.app.environment.AUTH_ORIGIN, config.origin);
  assert.equal(spec.services.proxy.environment.MQ_TLS_MODE, preview ? "private" : "public");
  assert.equal(Number(spec.services.app.mem_limit), 1536 * 1024 ** 2);
  assert.equal(Number(spec.services.postgres.mem_limit), 768 * 1024 ** 2);
  assert.ok(spec.services.postgres.volumes.some(v => v.target === "/var/lib/postgresql"));
}

async function writeControlFile(path, bytes) {
  const temporary = `${path}.next`;
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function publicHttpsHealthy(origin) {
  // Public trust store and hostname checks stay on. No local CA override.
  for (let attempt = 0; attempt < 60; attempt++) {
    const ok = await new Promise(done => {
      const request = https.get(new URL("/api/stories", origin), { timeout: 3000 }, response => { response.resume(); done(response.statusCode === 200); });
      request.on("error", () => done(false)); request.on("timeout", () => request.destroy());
    });
    if (ok) return true; await delay(1000);
  }
  return false;
}

export async function privateHttpsHealthy({ origin, preview, ca }, { attempts = 60, waitMs = 1000 } = {}) {
  assert.ok(Buffer.isBuffer(ca) && ca.length > 0, "PRODUCTION_PREVIEW_CA_REQUIRED");
  const hostname = new URL(origin).hostname;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ok = await new Promise(done => {
      const request = https.get({ hostname: "127.0.0.1", port: preview.port, path: "/api/stories",
        servername: hostname, ca, rejectUnauthorized: true, timeout: 3000, headers: { host: hostname },
        checkServerIdentity: (_, cert) => checkServerIdentity(hostname, cert) }, response => {
        response.resume(); done(response.statusCode === 200);
      });
      request.on("error", () => done(false)); request.on("timeout", () => request.destroy());
    });
    if (ok) return true;
    await delay(waitMs);
  }
  return false;
}

// A receipt includes four OCI manifests and nine migrations, so it is larger
// than a secret. Keep the 4 KiB secret limit; use a separate private 64 KiB cap.
export async function readProductionReceipt(path) {
  await privateDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const info = await file.stat();
    assert.ok(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 65536, "PRODUCTION_RECEIPT_FILE_REJECTED");
    if (process.platform !== "win32") assert.ok(info.uid === 0 && (info.mode & 0o7777) === 0o600, "PRODUCTION_RECEIPT_FILE_REJECTED");
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await file.read(bytes, count, bytes.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    assert.equal(count, info.size, "PRODUCTION_RECEIPT_FILE_REJECTED");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } finally { await file.close(); }
}

export async function prepareProductionHost(settingsFile, action, { verify = verifyReleaseBundle } = {}) {
  assert.equal(process.platform, "linux", "PRODUCTION_HOST_LINUX_REQUIRED");
  assert.equal(process.getuid(), 0, "PRODUCTION_HOST_ROOT_REQUIRED");
  assert.ok(["bootstrap", "upgrade", "rollback", "activate", "private-preview", "close-preview"].includes(action));
  const settings = JSON.parse(await readDeploymentFile(settingsFile));
  const config = await readDeploymentManifest(settings.deploymentFile);
  const manifest = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "roles"));
  validateHostSettings(settings, config);
  await privateDirectory(dirname(settings.targetDirectory));
  await readSecrets(settings.secretDirectory, config);
  const release = await verify(settings.candidateDirectory, settings.candidateManifestSha256);
  // Generated on the operator's workstation by the live GitHub gate command.
  // This root-owned offline record is not a signature or a substitute for the
  // operator's approval; no GitHub token is copied to the host.
  validateCurrentReleaseGate(JSON.parse(await readDeploymentFile(settings.gateFile)), release.sourceSha);
  assert.deepEqual(release.compatibility, await releaseCompatibility(source), "PRODUCTION_TOOL_CONTRACT_MISMATCH");
  let receipt, currentRelease;
  if (action !== "bootstrap") {
    await privateDirectory(settings.targetDirectory);
    receipt = await readProductionReceipt(join(settings.targetDirectory, "receipt.json"));
    assert.equal(receipt.deploymentId, config.deploymentId);
    assert.equal(receipt.configSha256, sha256(JSON.stringify(config)), "PRODUCTION_TARGET_CHANGED");
    currentRelease = receipt.release;
  }
  if (receipt?.privateIngress === true) assert.equal(action, "close-preview", "PRODUCTION_PREVIEW_MUST_CLOSE");
  if (action === "private-preview") assert.ok(settings.preview, "PRODUCTION_PREVIEW_REJECTED");
  else assert.equal(settings.preview, undefined, "PRODUCTION_PREVIEW_SETTINGS_REJECTED");
  const previewTls = action === "private-preview" ? await readPrivatePreviewFiles(settings.preview, config.origin) : undefined;
  const plan = action === "bootstrap"
    ? planProductionBootstrap({ release, config: manifest, candidateManifestSha256: settings.candidateManifestSha256 })
    : action === "activate"
      ? planProductionActivation({ currentRelease, config: manifest, receipt, features: settings.features })
      : action === "private-preview" ? planProductionPrivatePreview({ currentRelease, config: manifest, receipt,
        preview: settings.preview, features: settings.features })
        : action === "close-preview" ? planProductionPreviewClose({ currentRelease, config: manifest, receipt })
        : planProductionChange({ release, currentRelease, config: manifest, candidateManifestSha256: settings.candidateManifestSha256,
        backupReceipt: await readBackupReceipt(join(settings.targetDirectory, "backup-receipts", "latest.json")), mode: action, features: settings.features });
  if (action === "bootstrap") assert.ok(Object.values(settings.features).every(value => value === false), "PRODUCTION_BOOTSTRAP_FEATURES_DISABLED");
  if (action === "close-preview") assert.ok(Object.values(settings.features).every(value => value === false), "PRODUCTION_PREVIEW_CLOSE_FEATURES_DISABLED");
  if (["activate", "private-preview", "close-preview"].includes(action)) {
    assert.deepEqual(release, receipt.release, "PRODUCTION_ACTIVATION_RELEASE_CHANGED");
    assert.equal(settings.candidateManifestSha256, receipt.candidateManifestSha256, "PRODUCTION_ACTIVATION_RELEASE_CHANGED");
  }
  return { settings, config, release, plan, priorReceipt: receipt, previewTls };
}

/** Fixed host executor. There is deliberately no arbitrary shell hook or
 * operator-supplied compose override. Planning never writes host state. */
export async function applyProductionHost(context, confirmation, { runDocker = docker, claimOperation = claimProductionOperation,
  inspectSpace = statfs, probeHttps = publicHttpsHealthy, probePrivateHttps = privateHttpsHealthy,
  inspectPrivateRouting = privateDockerRouting } = {}) {
  const { settings, config, plan, release, priorReceipt } = context;
  const approval = JSON.parse(await readDeploymentFile(settings.approvalFile));
  const directory = settings.targetDirectory;
  const images = Object.fromEntries(TARGETS.map(name => [name, release.images[name].indexDigest]));
  const base = ["compose", "--project-name", "mq-production", "--env-file", join(directory, "compose.env"),
    "-f", join(source, "compose.production.yaml"), "-f", join(directory, "closed.yaml")];
  const compose = (args, options) => runDocker([...base, ...args], options);
  let prepared = false, claim, targetOwned = false, claimAttempted = false;
  const operation = (name, identity, extra = []) => {
    const args = ["run", "--rm", "--no-deps"];
    const mounts = identity === "bootstrap" ? ["bootstrap_database_url", ...(name === "bootstrap" ? ["role_passwords"] : []),
      ...(name === "keys" ? ["publish_signing_key", "comment_signing_key"] : [])]
      : [identity === "runtime" ? "database_url" : "migration_database_url"];
    for (const file of mounts) args.push("-v", `${join(settings.secretDirectory, file)}:/run/operation/${file}:ro`);
    args.push("-e", `${identity.toUpperCase()}_DATABASE_URL_FILE=/run/operation/${identity === "runtime" ? "database_url" : `${identity}_database_url`}`);
    if (name === "bootstrap") args.push("-e", "MQ_ROLE_PASSWORDS_FILE=/run/operation/role_passwords");
    if (name === "keys") args.push("-e", "MQ_PUBLISH_SIGNING_KEY_FILE=/run/operation/publish_signing_key", "-e", "MQ_COMMENT_SIGNING_KEY_FILE=/run/operation/comment_signing_key");
    return compose([...args, "tools", "scripts/production/database-cli.mjs", name,
      ...(name === "audit" ? [] : [`--confirm-production=${config.deploymentId}`]), ...extra]);
  };
  const rotatePreview = name => compose(["run", "--rm", "--no-deps", "-v",
    `${join(settings.secretDirectory, "bootstrap_database_url")}:/run/operation/bootstrap_database_url:ro`,
    "-e", "BOOTSTRAP_DATABASE_URL_FILE=/run/operation/bootstrap_database_url", "tools",
    "scripts/production/rotation-cli.mjs", name, `--confirm-deployment=${config.deploymentId}`]);
  async function writeEnvironment(features) {
    const env = { MQ_DEPLOYMENT_ENV: "production", MQ_DATABASE_NAME: "mq_production", MQ_AUTH_ORIGIN: config.origin,
      MQ_PUBLIC_HOST: new URL(config.origin).hostname, MQ_DEPLOYMENT_CONFIG: settings.deploymentFile,
      MQ_SECRET_DIRECTORY: settings.secretDirectory, MQ_APP_IMAGE: images.app, MQ_TOOLS_IMAGE: images.tools, MQ_PROXY_IMAGE: images.proxy,
      MQ_AUTH_ENABLED: String(features.auth), MQ_MEDIA_ENABLED: String(features.media), MQ_PUBLISH_ENABLED: String(features.publishing), MQ_COMMENTS_ENABLED: String(features.comments) };
    for (const value of Object.values(env)) assert.ok(!/[\s\0$#'"\\]/.test(value), "PRODUCTION_ENVIRONMENT_REJECTED");
    await writeControlFile(join(directory, "compose.env"), Object.entries(env).map(([k,v]) => `${k}=${v}`).join("\n") + "\n");
  }
  const execute = async step => {
    if (step === "preflight") {
      const info = JSON.parse(runDocker(["info", "--format", "{{json .}}"] ).stdout);
      assert.equal(info.OSType, "linux"); assert.ok(["amd64", "x86_64"].includes(info.Architecture));
      // Docker <28 has a documented LAN bypass for localhost publications.
      if (plan.action === "private-preview") {
        assert.ok(Number.parseInt(info.ServerVersion, 10) >= 28, "PRODUCTION_PREVIEW_DOCKER_VERSION_REQUIRED");
        assert.equal(await inspectPrivateRouting(), true, "PRODUCTION_PREVIEW_ROUTING_REJECTED");
        // A closed bootstrap starts only postgres/app, so Compose has not yet
        // created proxy's edge network. Only an absent edge is permissible;
        // a failed Docker command or a missing/unsafe frontend still blocks.
        const edge = runDocker(["network", "ls", "--filter", "name=^mq-production_edge$", "--format", "{{.Name}}"]).stdout.trim();
        assert.ok(edge === "" || edge === "mq-production_edge", "PRODUCTION_PREVIEW_NETWORK_REJECTED");
        assertPrivateProxyNetworks(JSON.parse(runDocker(["network", "inspect", ...(edge ? [edge] : []), "mq-production_frontend"]).stdout),
          { allowMissingEdge: true });
      }
      for (const path of [dirname(directory), info.DockerRootDir]) {
        const space = await inspectSpace(path);
        const extra = ["activate", "private-preview", "close-preview"].includes(plan.action) ? 0 : Object.values(release.images).reduce((n,i)=>n+i.archiveBytes,0)*2;
        assert.ok(space.bavail * space.bsize >= reserve + extra, "PRODUCTION_DISK_RESERVE_LOW");
        assert.ok(space.files === 0 || space.ffree / space.files >= 0.05, "PRODUCTION_INODES_LOW");
      }
      if (plan.action === "bootstrap") {
        let exists = false; try { await lstat(directory); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
        assert.equal(exists, false, "PRODUCTION_EXISTING_TARGET_REJECTED");
        for (const args of [["ps", "-aq", "--filter", "label=com.docker.compose.project=mq-production"],
          ["volume", "ls", "-q", "--filter", "name=mq-production"], ["network", "ls", "-q", "--filter", "name=mq-production"]])
          assert.equal(runDocker(args).stdout.trim(), "", "PRODUCTION_EXISTING_RESOURCES_REJECTED");
      } else {
        const marker = JSON.parse(await readDeploymentFile(join(directory, "target.json"), { secret: true }));
        assert.deepEqual(marker, { version: 1, deploymentId: config.deploymentId, project: "mq-production" });
        if (priorReceipt.privateIngress === true) assert.equal(plan.action, "close-preview", "PRODUCTION_PREVIEW_MUST_CLOSE");
        if (priorReceipt.publicIngress === false && priorReceipt.privateIngress !== true) {
          const ids = compose(["ps", "--all", "--quiet", "proxy"]).stdout.trim().split(/\s+/).filter(Boolean);
          assert.ok(ids.length <= 1, "PRODUCTION_PROXY_STATE_REJECTED");
          if (ids.length) {
            assert.match(ids[0], /^[a-f0-9]{12,64}$/);
            const containers = JSON.parse(runDocker(["inspect", ...ids]).stdout);
            assert.equal(containers.length, 1);
            assert.equal(containers[0].Config.Labels["com.docker.compose.project"], "mq-production");
            assert.equal(containers[0].Config.Labels["com.docker.compose.service"], "proxy");
            assert.equal(containers[0].State.Running, false, "PRODUCTION_CLOSED_RECEIPT_CONTRADICTED");
          }
        }
      }
      return true;
    }
    // Activation's first audit is genuinely read-only. No lock, env file or
    // service state is changed until the following app step.
    if (!prepared && ["activate", "private-preview"].includes(plan.action) && step === "audit") {
      operation("audit", "runtime"); return;
    }
    if (!claim) {
      // A failed claim must not be retried by the plan's containment callbacks:
      // the project might belong to the operation that won the lock.
      assert.equal(claimAttempted, false, "PRODUCTION_OPERATION_NOT_OWNED");
      claimAttempted = true;
      claim = await claimOperation({ deploymentId: config.deploymentId, kind: "release", operationId: plan.planId });
      if (plan.action !== "bootstrap") {
        // Another completed operation between preflight and claim invalidates
        // this snapshot. Do not stop a newly updated deployment on its behalf.
        assert.deepEqual(await readProductionReceipt(join(directory, "receipt.json")), priorReceipt, "PRODUCTION_CURRENT_RELEASE_CHANGED");
        const marker = JSON.parse(await readDeploymentFile(join(directory, "target.json"), { secret: true }));
        assert.deepEqual(marker, { version: 1, deploymentId: config.deploymentId, project: "mq-production" });
        targetOwned = true;
      }
    }
    await claim.assertOwned();
    if (!prepared && !["close-ingress", "stop-app"].includes(step)) {
      if (plan.action === "bootstrap") {
        await mkdir(directory, { mode: 0o700 });
        targetOwned = true;
        await writeFile(join(directory, "target.json"), JSON.stringify({ version: 1, deploymentId: config.deploymentId, project: "mq-production" }), { flag: "wx", mode: 0o600 });
        await mkdir(join(directory, "backup-receipts"), { mode: 0o700 });
        await chown(join(directory, "backup-receipts"), 10001, 10001);
      }
      if (!["activate", "private-preview", "close-preview"].includes(plan.action)) for (const name of TARGETS) {
        runDocker(["image", "load", "--input", join(settings.candidateDirectory, release.images[name].file)], { timeout: 600000 });
        const image = JSON.parse(runDocker(["image", "inspect", `mq-release-${name}:${release.sourceSha}`, "--format", "{{json .Descriptor}}"] ).stdout);
        assert.equal(image.digest, images[name], "PRODUCTION_LOADED_IMAGE_MISMATCH");
      }
      await writeEnvironment(plan.features);
      await writeControlFile(join(directory, "closed.yaml"), "services:\n  proxy:\n    ports: !reset []\n");
      assertProductionCompose(JSON.parse(compose(["config", "--format", "json"]).stdout), { images, config });
      prepared = true;
    }
    switch (step) {
      case "close-ingress": assert.ok(targetOwned, "PRODUCTION_TARGET_NOT_OWNED"); compose(["stop", "proxy"]); return;
      case "stop-app": assert.ok(targetOwned, "PRODUCTION_TARGET_NOT_OWNED"); compose(["stop", "app"]); return;
      case "pause-preview-writers": rotatePreview("pause"); return;
      case "revoke-preview-sessions": rotatePreview("revoke-sessions"); return;
      case "resume-preview-writers": rotatePreview("resume"); return;
      case "postgres": compose(["up", "-d", "--wait", "--wait-timeout", "180", "postgres"]); return;
      case "bootstrap": operation("bootstrap", "bootstrap"); return;
      case "migrate": operation("migrate", "migration"); return;
      case "provision": operation("provision", "bootstrap"); return;
      case "keys": operation("keys", "bootstrap"); return;
      case "audit": operation("audit", "runtime"); return;
      case "volumes-init": compose(["run", "--rm", "--no-deps", "volumes-init"]); return;
      case "media-init": compose(["run", "--rm", "--no-deps", "tools", "scripts/production/init-media.mjs"]); return;
      case "app": compose(["up", "-d", "--wait", "--wait-timeout", "180", "app"]); return;
      case "health": compose(["exec", "-T", "app", "node", "scripts/production/healthcheck.mjs"]); return true;
      case "open-ingress": {
        // Only the separate activate plan can reach this step. This file is
        // never written by bootstrap/upgrade/rollback, including on success.
        assert.equal(plan.action, "activate");
        await writeControlFile(join(directory, "closed.yaml"), "services:\n  proxy:\n    ports: !override [\"80:80\", \"443:443\"]\n");
        assertProductionCompose(JSON.parse(compose(["config", "--format", "json"]).stdout), { images, config, openIngress: true });
        compose(["up", "-d", "--wait", "--wait-timeout", "180", "proxy"]); return;
      }
      case "open-private-ingress": {
        assert.equal(plan.action, "private-preview");
        const p = plan.preview;
        // Only this fixed template can add private ingress; settings never
        // accept an arbitrary Compose file or Caddy directive.
        await writeControlFile(join(directory, "closed.yaml"), `services:
  proxy:
    ports: !override ["127.0.0.1:${p.port}:443"]
    environment:
      MQ_TLS_MODE: private
    secrets: [auth_proxy_secret, preview_certificate, preview_private_key]
secrets:
  preview_certificate:
    file: ${p.certificate.path}
  preview_private_key:
    file: ${p.privateKey.path}
`);
        assertProductionCompose(JSON.parse(compose(["config", "--format", "json"]).stdout), { images, config, preview: p });
        // Create does not start the proxy or publish its ports. Validate the
        // networks Compose actually created before allowing the first start.
        compose(["create", "--no-deps", "proxy"]);
        assertPrivateProxyNetworks(JSON.parse(runDocker(["network", "inspect", "mq-production_edge", "mq-production_frontend"]).stdout));
        compose(["up", "-d", "--wait", "--wait-timeout", "180", "proxy"]);
        const ids = compose(["ps", "--all", "--quiet", "proxy"]).stdout.trim().split(/\s+/).filter(Boolean);
        assert.equal(ids.length, 1, "PRODUCTION_PREVIEW_PROXY_REQUIRED");
        assert.match(ids[0], /^[a-f0-9]{12,64}$/);
        const [container] = JSON.parse(runDocker(["inspect", ...ids]).stdout);
        assert.equal(container.Config.Labels["com.docker.compose.project"], "mq-production");
        assert.equal(container.Config.Labels["com.docker.compose.service"], "proxy");
        assert.equal(container.State.Running, true);
        for (const ports of [container.HostConfig.PortBindings, container.NetworkSettings.Ports]) {
          const bound = Object.fromEntries(Object.entries(ports).filter(([, value]) => value?.length));
          assert.deepEqual(bound, { "443/tcp": [{ HostIp: "127.0.0.1", HostPort: String(p.port) }] }, "PRODUCTION_PREVIEW_LOOPBACK_REQUIRED");
        }
        return;
      }
      case "https": return probeHttps(config.origin);
      case "private-https": return probePrivateHttps({ origin: config.origin, preview: plan.preview, ca: context.previewTls?.ca });
      case "receipt": {
        const receipt = { version: 1, verified: true, deploymentId: config.deploymentId, sourceSha: release.sourceSha,
          candidateManifestSha256: settings.candidateManifestSha256, completedAt: new Date().toISOString(), action: plan.action,
          features: plan.features, publicIngress: plan.action === "activate", configSha256: sha256(JSON.stringify(config)),
          release, previousSourceSha: priorReceipt?.sourceSha ?? null, planId: plan.planId };
        if (plan.action === "private-preview") Object.assign(receipt, { privateIngress: true, preview: plan.preview });
        if (plan.action === "close-preview") Object.assign(receipt, { privateIngress: false, previewSessionsRevoked: true });
        if (priorReceipt) await writeFile(join(directory, `receipt-${priorReceipt.planId}.json`), JSON.stringify(priorReceipt), { flag: "wx", mode: 0o600 });
        await writeControlFile(join(directory, "receipt.json"), JSON.stringify(receipt));
        // Preserve the operation record rather than deleting evidence.
        await claim.complete(directory);
        return receipt;
      }
      default: throw new Error("PRODUCTION_STEP_REJECTED");
    }
  };
  return executeProductionPlan({ plan, approval, confirmation, execute });
}
