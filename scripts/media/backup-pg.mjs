import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { URL } from "node:url";
import { backupError } from "./backup-files.mjs";

export function localBackupTarget(value, expectedDatabase) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !url.port || url.search || url.hash || !/^[a-z][a-z0-9_]{2,62}$/.test(expectedDatabase ?? "")
    || url.pathname !== `/${expectedDatabase}` || ["postgres", "template0", "template1"].includes(expectedDatabase)) {
    throw backupError("BACKUP_TARGET_REJECTED");
  }
  if (/[\r\n]/.test(decodeURIComponent(url.password))) throw backupError("BACKUP_TARGET_REJECTED");
  return url;
}

/** PostgreSQL's native tools, never a JSON substitute for a database backup.
 * Docker is optional and uses an existing operator-selected PG18 container.
 * Password travels in the child environment/native mode or stdin/Docker mode,
 * never argv. Tool stderr can contain private rows and is deliberately discarded. */
export async function runPgBackupTool(tool, args, url, { input, output, container } = {}) {
  const password = decodeURIComponent(url.password);
  const env = { ...process.env, PGHOST: url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: password, PGDATABASE: url.pathname.slice(1), PGCONNECT_TIMEOUT: "5" };
  let executable = tool, argv = args;
  if (container) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw backupError("BACKUP_TOOL_REJECTED");
    executable = "docker";
    // sh reads exactly the secret line; pg_restore receives the remaining binary stream.
    argv = ["exec", "-i", container, "sh", "-c", "IFS= read -r PGPASSWORD; export PGPASSWORD; exec timeout 300s \"$@\"", "mq-pg-tool",
      tool, "--host=127.0.0.1", "--port=5432", `--username=${env.PGUSER}`, `--dbname=${env.PGDATABASE}`, ...args];
    delete env.PGPASSWORD;
  }
  const child = spawn(executable, argv, { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  child.stdin.on("error", () => {});
  const complete = new Promise((accept, reject) => {
    child.once("error", () => reject(backupError("BACKUP_TOOL_FAILED")));
    child.once("close", code => code === 0 ? accept() : reject(backupError("BACKUP_TOOL_FAILED")));
  });
  complete.catch(() => {});
  const timer = globalThis.setTimeout(() => child.kill(), 300_000);
  try {
    if (container) child.stdin.write(`${password}\n`);
    const sending = input ? pipeline(createReadStream(input), child.stdin) : Promise.resolve(child.stdin.end());
    let dumped = 0;
    const bound = new Transform({ transform(chunk, encoding, callback) {
      dumped += chunk.length;
      callback(dumped > 512 * 1024 * 1024 ? backupError("BACKUP_TOO_LARGE") : null, chunk);
    } });
    const receiving = output ? pipeline(child.stdout, bound, createWriteStream(output, { flags: "wx", mode: 0o600 })) : (child.stdout.resume(), Promise.resolve());
    await Promise.all([sending, receiving, complete]);
  } catch { child.kill(); throw backupError("BACKUP_TOOL_FAILED"); }
  finally { globalThis.clearTimeout(timer); }
}
