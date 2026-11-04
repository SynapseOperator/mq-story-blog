import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createPrivateChild, verifyPrivateDirectory, verifyPrivateFile, writePrivate } from "../scripts/media/backup-files.mjs";
import { createMediaBackup, verifyMediaBackup } from "../scripts/media/backup.mjs";
import { restoreMediaBackup } from "../scripts/media/restore.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mq-backup-unit-"));
  t.after(async () => {
    const actual = await realpath(root);
    assert.equal(actual, resolve(root)); assert.equal(dirname(actual), await realpath(tmpdir()));
    assert.ok(basename(actual).startsWith("mq-backup-unit-"));
    await rm(actual, { recursive: true, force: false });
  });
  return root;
}

test("backup child has private permissions/Windows ACL before sensitive bytes are written", async t => {
  const root = await fixture(t), directory = await createPrivateChild(root, "mq-backup-");
  await verifyPrivateDirectory(directory);
  const path = join(directory, "synthetic.bin"); await writePrivate(path, Buffer.from("synthetic"));
  assert.equal((await verifyPrivateFile(path, 100)).toString(), "synthetic");
  await assert.rejects(writePrivate(path, Buffer.from("must not overwrite")));
  assert.equal((await readFile(path)).toString(), "synthetic");
  await assert.rejects(verifyPrivateFile(path, 2));
});

test("backup refuses Git trees and missing completion markers", async t => {
  const root = await fixture(t);
  const git = join(root, "checkout"); await mkdir(git); await mkdir(join(git, ".git"));
  await assert.rejects(createPrivateChild(git, "mq-backup-"), { code: "BACKUP_PATH_REJECTED" });
  const directory = await createPrivateChild(root, "mq-backup-");
  await assert.rejects(verifyMediaBackup(directory));
});

test("restore cannot target development or an existing selected database", async () => {
  for (const controlURL of ["postgresql://mq_dev:synthetic@127.0.0.1:55432/mq_development",
    "postgresql://mq_test:synthetic@127.0.0.1:55433/existing", "postgresql://mq_test:synthetic@remote.invalid:5432/mq_test"]) {
    await assert.rejects(restoreMediaBackup({ controlURL }), { code: "RESTORE_TARGET_REJECTED" });
  }
  await assert.rejects(createMediaBackup({ databaseURL: "postgresql://mq_test:synthetic@remote.invalid:5432/mq_test", expectedDatabase: "mq_test" }), { code: "BACKUP_TARGET_REJECTED" });
  await assert.rejects(createMediaBackup({ databaseURL: "postgresql://mq_test:synthetic@127.0.0.1:55433/postgres", expectedDatabase: "postgres" }), { code: "BACKUP_TARGET_REJECTED" });
});

test("backup CLI refuses unattended execution and credentials passed as extra arguments", async () => {
  const run = args => new Promise((accept, reject) => {
    const child = spawn(process.execPath, ["scripts/media/backup-cli.mjs", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    child.once("error", reject); child.once("close", code => accept({ code, output }));
  });
  const unattended = await run(["backup", "mq_test"]); assert.equal(unattended.code, 1); assert.match(unattended.output, /TTY_REQUIRED/);
  const injected = await run(["backup", "mq_test", "synthetic_secret"]); assert.equal(injected.code, 1);
  assert.match(injected.output, /INVALID_ARGUMENTS/); assert.ok(!injected.output.includes("synthetic_secret"));
});
