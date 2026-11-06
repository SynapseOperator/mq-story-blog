import { constants } from "node:fs";
import { lstat, realpath, readdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readDeploymentManifest } from "./runtime-config.mjs";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";

/** A pre-created, privately owned volume only. Never chown an arbitrary host
 * path, replace an existing identity, create a missing root or delete files. */
export async function initializeMediaVolume(config, { projectRoot = process.cwd() } = {}) {
  try {
    const root = resolve(config.media.root), project = resolve(projectRoot), offset = relative(project, root);
    const inverse = relative(root, project);
    const contains = value => !value || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
    if (!isAbsolute(config.media.root) || contains(offset) || contains(inverse)) throw new Error();
    let current = parse(root).root;
    for (const part of relative(current, root).split(sep).filter(Boolean)) {
      current = join(current, part);
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error();
    }
    if (await realpath(root) !== root) throw new Error();
    for (let ancestor = root; ; ancestor = dirname(ancestor)) {
      try { await lstat(join(ancestor, ".git")); throw new Error(); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (ancestor === dirname(ancestor)) break;
    }
    const info = await lstat(root);
    if (process.platform !== "win32"
      && ((info.mode & 0o7777) !== 0o700 || info.uid !== 10001 || process.geteuid() !== 10001)) throw new Error();
    const entries = await readdir(root), marker = join(root, ".mq-deployment.json");
    if (!entries.includes(".mq-deployment.json")) {
      if (entries.length) throw new Error();
      const identity = JSON.stringify({ version: 1, environment: config.environment, deploymentId: config.deploymentId }) + "\n";
      const file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await file.writeFile(identity); await file.sync(); } finally { await file.close(); }
    }
    await createLocalMediaStore({ projectRoot, maxVariantBytes: 4 * 1024 * 1024, environment: config.environment,
      root, deploymentId: config.deploymentId, minimumFreeBytes: config.media.minFreeBytes });
    return { initialized: true };
  } catch { throw new Error("DEPLOYMENT_MEDIA_INITIALIZATION_REJECTED"); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = await readDeploymentManifest(process.env.MQ_DEPLOYMENT_CONFIG);
    if (process.env.MQ_DEPLOYMENT_ENV !== config.environment) throw new Error();
    await initializeMediaVolume(config);
    console.log("DEPLOYMENT_MEDIA_INITIALIZED");
  } catch { console.error("DEPLOYMENT_MEDIA_INITIALIZATION_REJECTED"); process.exitCode = 1; }
}
