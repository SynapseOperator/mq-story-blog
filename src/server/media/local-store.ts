import { constants } from "node:fs";
import { lstat, realpath, mkdir, open, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type MediaVariant = "display" | "thumbnail";
export type MediaStorageCode = "INVALID_CONFIGURATION" | "INVALID_OBJECT" | "UNSAFE_PATH"
  | "TOO_LARGE" | "ALREADY_EXISTS" | "NOT_FOUND" | "STORAGE_UNAVAILABLE";

/** Fixed codes only: private filesystem paths and driver messages are not public errors. */
export class MediaStorageError extends Error {
  readonly code: MediaStorageCode;
  constructor(code: MediaStorageCode) {
    super(code);
    this.name = "MediaStorageError";
    this.code = code;
  }
}

export type LocalMediaConfiguration = {
  projectRoot: string;
  roots: { development: string; test: string };
  environment: "development" | "test";
  maxVariantBytes: number;
};

export type LocalMediaStore = Readonly<{
  write(storageKey: string, variant: MediaVariant, processedWebp: Uint8Array): Promise<{ byteLength: number }>;
  read(storageKey: string, variant: MediaVariant): Promise<Buffer>;
}>;

const keyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const variantNames = { display: "display.webp", thumbnail: "thumbnail.webp" } as const;

function normalized(path: string) { return process.platform === "win32" ? path.toLowerCase() : path; }
function contains(parent: string, child: string) {
  const offset = relative(normalized(parent), normalized(child));
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

function storageError(error: unknown): MediaStorageError {
  if (error instanceof MediaStorageError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return new MediaStorageError(code === "ENOENT" ? "NOT_FOUND" : code === "EEXIST" ? "ALREADY_EXISTS" : "STORAGE_UNAVAILABLE");
}

function privateMode(mode: number, expected: number) {
  // Windows mode bits do not prove ACL isolation. Provision the private root with
  // a restrictive inherited ACL separately; this adapter never rewrites host ACLs.
  if (process.platform !== "win32" && (mode & 0o777) !== expected) throw new MediaStorageError("UNSAFE_PATH");
}

/** Detect ordinary symlinks/junctions, including an ancestor of the configured
 * root. This assumes a trusted private local directory: Node path checks cannot
 * make a hostile same-privilege process, arbitrary reparse driver or host safe.
 */
async function inspectPath(path: string, directory: boolean) {
  const full = resolve(path);
  const volume = parse(full).root;
  const components = relative(volume, full).split(sep).filter(Boolean);
  let current = volume;
  for (const component of components) {
    current = join(current, component);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (current !== full && !entry.isDirectory())) throw new MediaStorageError("UNSAFE_PATH");
  }
  const entry = await lstat(full);
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())) throw new MediaStorageError("UNSAFE_PATH");
  if (normalized(await realpath(full)) !== normalized(full)) throw new MediaStorageError("UNSAFE_PATH");
  return entry;
}

async function outsideGit(path: string) {
  for (let current = path; ; current = dirname(current)) {
    try { await lstat(join(current, ".git")); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        if (dirname(current) === current) return;
        continue;
      }
      throw error;
    }
    throw new MediaStorageError("INVALID_CONFIGURATION");
  }
}

/** Private LOCAL storage for ALREADY processed WebP variants. No upload parsing,
 * image decoding, MIME validation, original variant, public URL or deletion API.
 * Roots must be pre-created, separate, absolute, outside every Git checkout and
 * the project/build/public tree. No environment/cwd fallback is permitted.
 */
export async function createLocalMediaStore(config: LocalMediaConfiguration): Promise<LocalMediaStore> {
  let root: string;
  const maxBytes = config?.maxVariantBytes;
  try {
    const roots = [config?.projectRoot, config?.roots?.development, config?.roots?.test];
    if (roots.some(value => typeof value !== "string" || !isAbsolute(value))
      || !["development", "test"].includes(config?.environment)
      || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new MediaStorageError("INVALID_CONFIGURATION");
    const [projectRoot, development, test] = roots.map(value => resolve(value));
    if ([development, test].some(value => contains(projectRoot, value) || contains(value, projectRoot))
      || contains(development, test) || contains(test, development)) throw new MediaStorageError("INVALID_CONFIGURATION");
    await inspectPath(projectRoot, true);
    // Only the selected root needs to exist; validation never creates or touches
    // the other environment. Existing aliases of either root are still rejected.
    for (const candidate of [development, test]) {
      let existing = candidate;
      while (true) {
        try { await inspectPath(existing, true); break; }
        catch (error) {
          if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT" || dirname(existing) === existing) throw error;
          existing = dirname(existing);
        }
      }
      await outsideGit(existing);
    }
    root = config.environment === "development" ? development : test;
    privateMode((await inspectPath(root, true)).mode, 0o700);
  } catch (error) {
    if (error instanceof MediaStorageError) throw error;
    throw new MediaStorageError("INVALID_CONFIGURATION");
  }

  function objectPath(storageKey: string, variant: MediaVariant) {
    if (typeof storageKey !== "string" || !keyPattern.test(storageKey)
      || typeof variant !== "string" || !Object.hasOwn(variantNames, variant)) throw new MediaStorageError("INVALID_OBJECT");
    return { directory: join(root, storageKey), file: join(root, storageKey, variantNames[variant]) };
  }

  async function write(storageKey: string, variant: MediaVariant, processedWebp: Uint8Array) {
    const target = objectPath(storageKey, variant);
    if (!(processedWebp instanceof Uint8Array) || processedWebp.byteLength === 0) throw new MediaStorageError("INVALID_OBJECT");
    if (processedWebp.byteLength > maxBytes) throw new MediaStorageError("TOO_LARGE");
    let temporary: string | undefined;
    try {
      privateMode((await inspectPath(root, true)).mode, 0o700);
      try { await mkdir(target.directory, { mode: 0o700 }); }
      catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      }
      privateMode((await inspectPath(target.directory, true)).mode, 0o700);
      const path = join(target.directory, `.pending-${randomUUID()}`);
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      temporary = path;
      try { await handle.writeFile(processedWebp); await handle.sync(); }
      finally { await handle.close(); }
      // Same-directory hard-link publication is atomic and fails if the target
      // exists. rename() would overwrite on some platforms; no unsafe fallback.
      await link(temporary, target.file);
      await unlink(temporary);
      temporary = undefined;
      return { byteLength: processedWebp.byteLength };
    } catch (error) { throw storageError(error); }
    finally {
      if (temporary) {
        try { await unlink(temporary); }
        catch { /* A failed cleanup must remain a storage failure, never delete siblings. */ }
      }
    }
  }

  async function read(storageKey: string, variant: MediaVariant) {
    const target = objectPath(storageKey, variant);
    try {
      privateMode((await inspectPath(root, true)).mode, 0o700);
      privateMode((await inspectPath(target.directory, true)).mode, 0o700);
      const entry = await inspectPath(target.file, false);
      privateMode(entry.mode, 0o600);
      if (entry.size > maxBytes) throw new MediaStorageError("TOO_LARGE");
      const handle = await open(target.file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size === 0) throw new MediaStorageError("INVALID_OBJECT");
        if (opened.size > maxBytes) throw new MediaStorageError("TOO_LARGE");
        const bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const result = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (result.bytesRead === 0) throw new MediaStorageError("STORAGE_UNAVAILABLE");
          offset += result.bytesRead;
        }
        return bytes;
      } finally { await handle.close(); }
    } catch (error) { throw storageError(error); }
  }

  return Object.freeze({ write, read });
}
