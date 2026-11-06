import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runBackupTool, restic } from "../scripts/production/backup-tools.mjs";

test("backup child failures and output overflow never expose child diagnostics", async () => {
  const secret = "synthetic-diagnostic-must-not-escape";
  for (const args of [["-e", `process.stderr.write('${secret}'); process.exit(3)`],
    ["-e", "process.stdout.write(Buffer.alloc(5*1024*1024))"]]) {
    await assert.rejects(runBackupTool(process.execPath, args), error => error.message === "BACKUP_TOOL_FAILED" && !error.cause);
  }
  await assert.rejects(runBackupTool("mq-missing-backup-tool", []), { message: "BACKUP_TOOL_FAILED" });
});

test("interrupted dump stops writing before the failed operation returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-backup-tool-"));
  const output = join(directory, "partial.dump");
  try {
    await assert.rejects(runBackupTool(process.execPath,
      ["-e", "process.stdout.write('partial');setInterval(()=>process.stdout.write('chunk'),25)"],
      { output, timeoutMs: 1000 }), { message: "BACKUP_TOOL_FAILED" });
    const stopped = await readFile(output);
    assert.ok(stopped.length > 0, "The child must have written actual partial data before interruption");
    await delay(100);
    assert.deepEqual(await readFile(output), stopped, "No child remains writing after a failure");
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    await rm(directory, { recursive: true });
  }
});

test("Restic rejects mutable snapshot aliases, nonempty restore targets and unsupported commands before running a binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-restic-boundary-"));
  const repository = join(directory, "repo"), target = join(directory, "target"), passwordFile = join(directory, "password");
  await mkdir(repository, { mode: 0o700 }); await mkdir(target, { mode: 0o700 });
  await writeFile(passwordFile, "a".repeat(64), { mode: 0o600 });
  await writeFile(join(target, "must-survive"), "existing", { mode: 0o600 });
  try {
    const options = { repository, passwordFile };
    for (const args of [["restore", "latest:/payload", "--target", target, "--verify"],
      ["restore", `${"a".repeat(64)}:/payload`, "--target", target, "--verify"], ["forget", "--prune"], ["unlock"]]) {
      await assert.rejects(restic(args, options), { message: "BACKUP_RESTIC_FAILED" });
    }
    assert.equal(await readFile(join(target, "must-survive"), "utf8"), "existing");
  } finally { await rm(directory, { recursive: true }); }
});
