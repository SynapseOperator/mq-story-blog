import { constants } from "node:fs";
import { lstat, realpath, open } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { URL } from "node:url";
import { validateDeploymentConfig, assertDatabaseUrl } from "./database-config.mjs";
import { createLocalMediaStore, checkMediaFreeSpace } from "../../src/server/media/local-store.ts";

export const RUNTIME_SECRET_NAMES = Object.freeze([
  "DATABASE_URL", "AUTH_SECRET", "SESSION_STORAGE_KEY", "AUTH_PROXY_SECRET", "MQ_PUBLISH_SIGNING_KEY", "MQ_COMMENT_SIGNING_KEY",
]);
const flags = ["MQ_AUTH_ENABLED", "MQ_MEDIA_ENABLED", "MQ_PUBLISH_ENABLED", "MQ_COMMENTS_ENABLED"];
const reject = () => { throw new Error("DEPLOYMENT_RUNTIME_CONFIG_REJECTED"); };
const contains = (parent, child) => {
  const difference = relative(parent, child);
  return !difference || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`));
};

/** Read one bounded configuration/secret file. No path or file contents appear
 * in errors. POSIX secret modes are verified; Windows unit tests do not claim
 * ACL assurance. Actual deployment and container acceptance run on Linux. */
export async function readDeploymentFile(path, { projectRoot = process.cwd(), secret = false } = {}) {
  try {
    if (typeof path !== "string" || !isAbsolute(path)) reject();
    const full = resolve(path), project = resolve(projectRoot);
    if (contains(project, full)) reject();
    let current = parse(full).root;
    for (const component of relative(current, full).split(sep).filter(Boolean)) {
      current = join(current, component);
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || (current !== full && !entry.isDirectory())) reject();
    }
    if (await realpath(full) !== full) reject();
    for (let ancestor = dirname(full); ; ancestor = dirname(ancestor)) {
      try { await lstat(join(ancestor, ".git")); reject(); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (ancestor === dirname(ancestor)) break;
    }
    const file = await open(full, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > (secret ? 4096 : 16384) || info.nlink !== 1) reject();
      if (process.platform !== "win32") {
        if (secret ? ![0o400, 0o600].includes(info.mode & 0o7777) : (info.mode & 0o222) !== 0) reject();
        if (![0, process.geteuid()].includes(info.uid)) reject();
      }
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await file.read(bytes, count, bytes.length - count, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (count !== info.size) reject();
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    } finally { await file.close(); }
  } catch { reject(); }
}

export async function readDeploymentManifest(path, { projectRoot = process.cwd() } = {}) {
  try {
    const value = JSON.parse(await readDeploymentFile(path, { projectRoot }));
    if (Object.keys(value).sort().join(",") !== "database,deploymentId,environment,media,origin,version") reject();
    const config = validateDeploymentConfig(value);
    const origin = new URL(config.origin);
    if (origin.protocol !== "https:" || origin.origin !== config.origin || origin.username || origin.password) reject();
    if (!config.media || Object.keys(config.media).sort().join(",") !== "minFreeBytes,root"
      || typeof config.media.root !== "string" || !isAbsolute(config.media.root)
      || !Number.isSafeInteger(config.media.minFreeBytes) || config.media.minFreeBytes < 256 * 1024 * 1024
      || config.media.minFreeBytes > 16 * 1024 * 1024 * 1024) reject();
    return config;
  } catch { reject(); }
}

/** Called before Next starts, never at build time. Return a fresh allowlisted
 * environment; do not inherit maintenance credentials or framework aliases. */
export async function loadRuntimeEnvironment(input = process.env, { projectRoot = process.cwd() } = {}) {
  try {
    if (input.NODE_ENV !== "production" || !["staging", "production"].includes(input.MQ_DEPLOYMENT_ENV)) reject();
    const config = await readDeploymentManifest(input.MQ_DEPLOYMENT_CONFIG, { projectRoot });
    if (input.MQ_DEPLOYMENT_ENV !== config.environment
      || (input.AUTH_ALLOW_LOCAL_HTTP !== undefined && input.AUTH_ALLOW_LOCAL_HTTP !== "false")) reject();
    for (const name of ["BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "MQ_AUTH_SECRET",
      "BETTER_AUTH_SECRET_FILE", "BETTER_AUTH_SECRETS_FILE", "MQ_AUTH_SECRET_FILE",
      "BETTER_AUTH_URL", "BETTER_AUTH_URL_FILE", ...RUNTIME_SECRET_NAMES]) {
      if (Object.hasOwn(input, name)) reject();
    }
    if (input.AUTH_ORIGIN !== undefined && input.AUTH_ORIGIN !== config.origin) reject();
    if (input.MQ_MEDIA_ENV !== undefined && input.MQ_MEDIA_ENV !== config.environment) reject();
    for (const name of ["MQ_MEDIA_ROOT", "MQ_MEDIA_DEPLOYMENT_ID", "MQ_MEDIA_MIN_FREE_BYTES", "MQ_MEDIA_DEVELOPMENT_ROOT", "MQ_MEDIA_TEST_ROOT"]) {
      if (Object.hasOwn(input, name)) reject();
    }
    const env = { NODE_ENV: "production", PORT: "3000", HOSTNAME: "0.0.0.0", NEXT_TELEMETRY_DISABLED: "1",
      AUTH_ORIGIN: config.origin, AUTH_ALLOW_LOCAL_HTTP: "false", MQ_DEPLOYMENT_ENV: config.environment,
      MQ_MEDIA_ENV: config.environment, MQ_MEDIA_ROOT: config.media.root, MQ_MEDIA_DEPLOYMENT_ID: config.deploymentId,
      MQ_MEDIA_MIN_FREE_BYTES: String(config.media.minFreeBytes) };
    for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "TZ", "SystemRoot", "WINDIR"]) {
      if (input[name]) env[name] = input[name];
    }
    for (const name of flags) {
      if (input[name] !== undefined && !["true", "false"].includes(input[name])) reject();
      env[name] = input[name] ?? "false";
    }
    for (const name of RUNTIME_SECRET_NAMES) {
      const value = (await readDeploymentFile(input[`${name}_FILE`], { projectRoot, secret: true })).replace(/\r?\n$/, "");
      if (!value || /[\r\n\0]/.test(value) || value.trim() !== value) reject();
      if (name !== "DATABASE_URL" && !/^[a-f0-9]{64}$/.test(value)) reject();
      env[name] = value;
    }
    const databaseUrl = assertDatabaseUrl(env.DATABASE_URL, config);
    if (new Set(RUNTIME_SECRET_NAMES.slice(1).map(name => env[name])).size !== RUNTIME_SECRET_NAMES.length - 1) reject();
    if (RUNTIME_SECRET_NAMES.slice(1).some(name => env[name] === decodeURIComponent(databaseUrl.password))) reject();
    const media = { projectRoot, maxVariantBytes: 4 * 1024 * 1024, environment: config.environment,
      root: config.media.root, deploymentId: config.deploymentId, minimumFreeBytes: config.media.minFreeBytes };
    await createLocalMediaStore(media);
    await checkMediaFreeSpace(media.root, media.minimumFreeBytes);
    return { env, config, media };
  } catch { reject(); }
}
