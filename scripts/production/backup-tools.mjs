import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readdir, statfs } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { setTimeout, clearTimeout } from "node:timers";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { privatePath } from "../media/backup-files.mjs";
import { readDeploymentFile } from "./runtime-config.mjs";

export const MAX_DUMP_BYTES = 512 * 1024 * 1024;
export const RESTIC_VERSION = "0.19.1";
export const containsPath = (parent, child) => {
  const part = relative(resolve(parent), resolve(child));
  return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};

export async function assertBackupPaths({ repository, passwordFile, workspace }) {
  assert.ok(!containsPath(process.cwd(), repository), "BACKUP_PATH_IN_APPLICATION");
  await privatePath(repository);
  await readDeploymentFile(passwordFile, { secret: true });
  if (workspace) {
    assert.ok(!containsPath(process.cwd(), workspace), "BACKUP_PATH_IN_APPLICATION");
    await privatePath(workspace);
    assert.ok(!containsPath(repository, workspace) && !containsPath(workspace, repository), "BACKUP_PATH_OVERLAP");
    assert.ok(!containsPath(workspace, passwordFile), "BACKUP_SECRET_IN_WORKSPACE");
  }
  assert.ok(!containsPath(repository, passwordFile), "BACKUP_SECRET_IN_REPOSITORY");
}

export async function requireBackupSpace(directory, bytes) {
  assert.ok(Number.isSafeInteger(bytes) && bytes >= 0);
  const space = await statfs(directory, { bigint: true });
  assert.ok(space.bavail * space.bsize >= BigInt(bytes) + 256n * 1024n * 1024n, "BACKUP_DISK_SPACE_LOW");
}

// Child tools receive an allowlist, never the operator's inherited environment.
// Their stderr may contain paths, SQL or rows and is deliberately not relayed.
export async function runBackupTool(executable, args, { env = {}, cwd, input, output, timeoutMs = 300_000 } = {}) {
  const inherited = {};
  for (const name of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TMP", "TEMP"]) if (process.env[name]) inherited[name] = process.env[name];
  const child = spawn(executable, args, { cwd, env: { ...inherited, ...env }, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  child.stdin.on("error", () => {});
  const complete = new Promise((accept, reject) => {
    child.once("error", () => reject(new Error("BACKUP_TOOL_FAILED")));
    child.once("close", code => code === 0 ? accept() : reject(new Error("BACKUP_TOOL_FAILED")));
  });
  complete.catch(() => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const chunks = []; let size = 0;
  const bound = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    callback(size > (output ? MAX_DUMP_BYTES : 4 * 1024 * 1024) ? new Error("BACKUP_OUTPUT_LIMIT") : null, chunk);
  } });
  let work = [];
  try {
    const incoming = input ? pipeline(createReadStream(input), child.stdin) : Promise.resolve(child.stdin.end());
    const receiving = output ? pipeline(child.stdout, bound, createWriteStream(output, { flags: "wx", mode: 0o600 }))
      : pipeline(child.stdout, bound, new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } }));
    work = [incoming, receiving, complete];
    await Promise.all(work);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    child.kill("SIGKILL");
    // Do not return while an interrupted dump can still write its output file.
    await Promise.allSettled(work);
    throw new Error("BACKUP_TOOL_FAILED");
  }
  finally { clearTimeout(timer); }
}

export function pgToolEnvironment(url) {
  return { PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: url.pathname.slice(1), PGCONNECT_TIMEOUT: "5", PGAPPNAME: "mq-backup-operations" };
}

export async function restic(args, { repository, passwordFile, cwd } = {}) {
  try {
    await assertBackupPaths({ repository, passwordFile });
    const password = (await readDeploymentFile(passwordFile, { secret: true })).replace(/\r?\n$/, "");
    assert.ok(password.length >= 32 && password.length <= 1024 && !/[\r\n\0]/.test(password));
    // No latest, arbitrary paths, prune, forget or automatic unlock operations.
    // This offline wrapper accepts only the four commands its caller needs.
    const command = args?.[0];
    if (command === "init") {
      assert.deepEqual(args, ["init", "--repository-version", "2"]);
      assert.deepEqual(await readdir(repository), []);
    } else if (command === "check") assert.deepEqual(args, ["check", "--read-data"]);
    else if (command === "backup") {
      assert.equal(args.length, 7);
      assert.deepEqual(args.slice(0, 3), ["backup", "--json", "--host"]);
      assert.match(args[3], /^mq-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      assert.deepEqual(args.slice(4), ["--tag", "mq-deployment-v1", "payload"]);
      await assertBackupPaths({ repository, passwordFile, workspace: cwd });
      await privatePath(join(cwd, "payload"));
    } else if (command === "restore") {
      assert.equal(args.length, 5);
      assert.match(args[1], /^[a-f0-9]{64}:\/payload$/);
      assert.equal(args[2], "--target"); assert.equal(args[4], "--verify");
      await assertBackupPaths({ repository, passwordFile, workspace: args[3] });
      assert.deepEqual(await readdir(args[3]), [], "BACKUP_RESTORE_TARGET_NOT_EMPTY");
    } else throw new Error("BACKUP_RESTIC_COMMAND_REJECTED");
    const version = await runBackupTool("restic", ["version"]);
    assert.ok(version.startsWith(`restic ${RESTIC_VERSION} `), "BACKUP_RESTIC_VERSION_REJECTED");
    return await runBackupTool("restic", ["--repo", repository, "--password-file", passwordFile, "--no-cache", ...args], { cwd,
      env: { GOMAXPROCS: "2" } });
  } catch { throw new Error("BACKUP_RESTIC_FAILED"); }
}

/** Initialization is explicit and only accepts an already-created empty private
 * directory. No automatic init on a failed/wrong-password repository lookup. */
export async function initializeBackupRepository(options) {
  await assertBackupPaths(options);
  assert.deepEqual(await readdir(options.repository), [], "BACKUP_REPOSITORY_NOT_EMPTY");
  await restic(["init", "--repository-version", "2"], options);
  const stat = await lstat(options.repository);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  return { initialized: true, encrypted: true, version: RESTIC_VERSION };
}
