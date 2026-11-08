import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, readdir, statfs } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { setTimeout, clearTimeout } from "node:timers";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { URL } from "node:url";
import { privatePath } from "../media/backup-files.mjs";
import { readDeploymentFile } from "./runtime-config.mjs";

export const MAX_DUMP_BYTES = 512 * 1024 * 1024;
export const RESTIC_VERSION = "0.19.1";
export const containsPath = (parent, child) => {
  const part = relative(resolve(parent), resolve(child));
  return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`));
};

// Internal callers retain the existing local default. The operator CLI must
// select a backend explicitly; a URL never changes a local call into S3.
export function backupBackend({ backend = "local", repository, s3, expectedRepositoryId }) {
  try {
    assert.ok(["local", "s3"].includes(backend), "BACKUP_BACKEND_REJECTED");
    if (backend === "local") {
      assert.equal(s3, undefined, "BACKUP_BACKEND_REJECTED");
      assert.equal(expectedRepositoryId, undefined, "BACKUP_BACKEND_REJECTED");
      assert.ok(typeof repository === "string" && isAbsolute(repository), "BACKUP_PATH_REJECTED");
    } else {
      assert.ok(typeof repository === "string" && repository.startsWith("s3:https://"), "BACKUP_BACKEND_REJECTED");
      const url = new URL(repository.slice(3));
      assert.equal(`s3:${url.href}`, repository, "BACKUP_BACKEND_REJECTED");
      assert.ok(!url.username && !url.password && !url.search && !url.hash, "BACKUP_BACKEND_REJECTED");
      const [bucket, ...prefix] = url.pathname.slice(1).split("/");
      assert.match(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "BACKUP_BACKEND_REJECTED");
      assert.ok(prefix.length > 0 && prefix.every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(part)), "BACKUP_BACKEND_REJECTED");
      assert.match(expectedRepositoryId ?? "", /^[a-f0-9]{64}$/, "BACKUP_REPOSITORY_ID_REQUIRED");
      assert.ok(s3 && typeof s3 === "object" && !Array.isArray(s3), "BACKUP_BACKEND_REJECTED");
      assert.ok(["credentialsFile,region", "caCertificateFile,credentialsFile,region"].includes(Object.keys(s3).sort().join(",")), "BACKUP_BACKEND_REJECTED");
      assert.match(s3.region ?? "", /^[a-z0-9][a-z0-9-]{0,62}$/, "BACKUP_BACKEND_REJECTED");
      assert.ok(typeof s3.credentialsFile === "string" && isAbsolute(s3.credentialsFile));
      if (s3.caCertificateFile !== undefined) assert.ok(typeof s3.caCertificateFile === "string" && isAbsolute(s3.caCertificateFile));
      if (url.hostname.endsWith(".r2.cloudflarestorage.com")) {
        // R2 uses account/jurisdiction endpoints and region auto. Its public TLS
        // must use system trust; a local lab CA is only for other S3 fixtures.
        assert.match(url.hostname, /^[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/);
        assert.equal(url.port, ""); assert.equal(s3.region, "auto");
        assert.equal(s3.caCertificateFile, undefined);
      }
      if (url.hostname.endsWith(".aliyuncs.com")) {
        // Restic 0.19.1's documented OSS endpoint/region pair. Do not mix it
        // with AWS SDK examples for the newer s3.oss-* endpoint family.
        assert.equal(url.hostname, "oss-cn-hongkong.aliyuncs.com");
        assert.equal(url.port, ""); assert.equal(s3.region, "oss-cn-hongkong");
        assert.match(bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
        assert.equal(s3.caCertificateFile, undefined);
      }
    }
    return backend;
  } catch { throw new Error("BACKUP_BACKEND_REJECTED"); }
}

export async function assertBackupPaths(options) {
  const { repository, passwordFile, workspace, s3 } = options;
  const backend = backupBackend(options);
  if (backend === "local") {
    assert.ok(!containsPath(process.cwd(), repository), "BACKUP_PATH_IN_APPLICATION");
    await privatePath(repository);
    assert.ok(!containsPath(repository, passwordFile), "BACKUP_SECRET_IN_REPOSITORY");
  }
  await readDeploymentFile(passwordFile, { secret: true });
  if (workspace) {
    assert.ok(!containsPath(process.cwd(), workspace), "BACKUP_PATH_IN_APPLICATION");
    await privatePath(workspace);
    if (backend === "local") assert.ok(!containsPath(repository, workspace) && !containsPath(workspace, repository), "BACKUP_PATH_OVERLAP");
    assert.ok(!containsPath(workspace, passwordFile), "BACKUP_SECRET_IN_WORKSPACE");
    if (backend === "s3") assert.ok(!containsPath(workspace, s3.credentialsFile), "BACKUP_SECRET_IN_WORKSPACE");
  }
}

/** Secrets exist only in this short-lived child's environment. They are not
 * Compose environment values, argv, default AWS profiles or command output. */
export async function readS3CredentialsEnvironment(credentialsFile) {
  try {
    const value = JSON.parse(await readDeploymentFile(credentialsFile, { secret: true }));
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    assert.ok(["accessKeyId,secretAccessKey", "accessKeyId,secretAccessKey,sessionToken"].includes(Object.keys(value).sort().join(",")));
    for (const item of Object.values(value)) assert.ok(typeof item === "string" && /^[\x21-\x7e]+$/.test(item));
    return { AWS_ACCESS_KEY_ID: value.accessKeyId, AWS_SECRET_ACCESS_KEY: value.secretAccessKey,
      ...(value.sessionToken ? { AWS_SESSION_TOKEN: value.sessionToken } : {}) };
  } catch { throw new Error("BACKUP_S3_CREDENTIALS_REJECTED"); }
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

export async function restic(args, options = {}) {
  try {
    const { repository, passwordFile, cwd, s3, expectedRepositoryId } = options;
    const backend = backupBackend(options);
    await assertBackupPaths(options);
    const password = (await readDeploymentFile(passwordFile, { secret: true })).replace(/\r?\n$/, "");
    assert.ok(password.length >= 32 && password.length <= 1024 && !/[\r\n\0]/.test(password));
    // No latest, arbitrary flags, actual retention deletion or automatic unlock.
    const command = args?.[0];
    if (command === "init") {
      assert.equal(backend, "local", "BACKUP_S3_INIT_REQUIRES_SEPARATE_PROVISIONING");
      assert.deepEqual(args, ["init", "--repository-version", "2"]);
      assert.deepEqual(await readdir(repository), []);
    } else if (command === "check") assert.deepEqual(args, ["check", "--read-data"]);
    else if (command === "backup") {
      assert.equal(args.length, 7);
      assert.deepEqual(args.slice(0, 3), ["backup", "--json", "--host"]);
      assert.match(args[3], /^mq-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      assert.deepEqual(args.slice(4), ["--tag", "mq-deployment-v1", "payload"]);
      await assertBackupPaths({ ...options, workspace: cwd });
      await privatePath(join(cwd, "payload"));
    } else if (command === "restore") {
      assert.equal(args.length, 5);
      assert.match(args[1], /^[a-f0-9]{64}:\/payload$/);
      assert.equal(args[2], "--target"); assert.equal(args[4], "--verify");
      await assertBackupPaths({ ...options, workspace: args[3] });
      assert.deepEqual(await readdir(args[3]), [], "BACKUP_RESTORE_TARGET_NOT_EMPTY");
    } else if (command === "forget") {
      assert.match(args[4] ?? "", /^mq-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      assert.deepEqual(args, ["forget", "--dry-run", "--json", "--host", args[4], "--tag", "mq-deployment-v1",
        "--group-by", "host,tags", "--keep-daily", "7", "--keep-weekly", "8"]);
    } else throw new Error("BACKUP_RESTIC_COMMAND_REJECTED");
    const common = ["--repo", repository, "--password-file", passwordFile, "--no-cache"];
    const env = { GOMAXPROCS: "2" };
    if (backend === "s3") {
      Object.assign(env, await readS3CredentialsEnvironment(s3.credentialsFile));
      const lookup = new URL(repository.slice(3)).hostname === "oss-cn-hongkong.aliyuncs.com" ? "dns" : "path";
      common.push("-o", `s3.region=${s3.region}`, "-o", `s3.bucket-lookup=${lookup}`, "-o", "s3.connections=2", "-o", "s3.retries=2");
      if (s3.caCertificateFile) {
        await readDeploymentFile(s3.caCertificateFile);
        common.push("--cacert", s3.caCertificateFile);
      }
    }
    const version = await runBackupTool("restic", ["version"]);
    assert.ok(version.startsWith(`restic ${RESTIC_VERSION} `), "BACKUP_RESTIC_VERSION_REJECTED");
    if (backend === "s3") {
      // Decrypt config before every operation: wrong bucket/prefix/password
      // cannot silently create or operate on another repository.
      const config = JSON.parse(await runBackupTool("restic", [...common, "cat", "config"], { env }));
      assert.equal(config.id, expectedRepositoryId, "BACKUP_REPOSITORY_ID_MISMATCH");
    }
    return await runBackupTool("restic", [...common, ...args], { cwd, env });
  } catch { throw new Error("BACKUP_RESTIC_FAILED"); }
}

/** Initialization is explicit and only accepts an already-created empty private
 * directory. No automatic init on a failed/wrong-password repository lookup. */
export async function initializeBackupRepository(options) {
  if (backupBackend(options) !== "local") throw new Error("BACKUP_S3_INIT_REQUIRES_SEPARATE_PROVISIONING");
  await assertBackupPaths(options);
  assert.deepEqual(await readdir(options.repository), [], "BACKUP_REPOSITORY_NOT_EMPTY");
  await restic(["init", "--repository-version", "2"], options);
  const stat = await lstat(options.repository);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  return { initialized: true, encrypted: true, version: RESTIC_VERSION };
}

/** Planning only. This wrapper has no executable forget/prune path. */
export async function retentionDryRun({ deploymentId, ...options }) {
  try {
    assert.match(deploymentId ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    const host = `mq-${deploymentId}`;
    const output = await restic(["forget", "--dry-run", "--json", "--host", host, "--tag", "mq-deployment-v1",
      "--group-by", "host,tags", "--keep-daily", "7", "--keep-weekly", "8"], options);
    // Restic 0.19.1 returns exit 0 with empty stdout when no snapshot matches.
    const groups = output.trim() ? JSON.parse(output) : [];
    assert.ok(Array.isArray(groups));
    const keep = [], candidates = [];
    for (const group of groups) {
      assert.equal(group.host, host);
      for (const [list, target] of [[group.keep ?? [], keep], [group.remove ?? [], candidates]]) {
        assert.ok(Array.isArray(list));
        for (const snapshot of list) {
          assert.match(snapshot.id ?? "", /^[a-f0-9]{64}$/);
          assert.equal(snapshot.hostname, host);
          assert.ok(snapshot.tags?.includes("mq-deployment-v1"));
          target.push(snapshot.id);
        }
      }
    }
    return { dryRun: true, deploymentId, policy: { daily: 7, weekly: 8 }, keep, candidates, deleted: 0 };
  } catch { throw new Error("BACKUP_RETENTION_PLAN_FAILED"); }
}
