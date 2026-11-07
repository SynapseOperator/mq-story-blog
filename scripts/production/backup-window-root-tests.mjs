import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, chown, link, lstat, readFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { backupWindowFixture } from "../../tests/production-backup-window.test.mjs";
import { readBackupReceipt, runBackupWindow } from "./backup-window.mjs";
import { readDeploymentFile } from "./runtime-config.mjs";

// A dedicated root-only Linux job, not a skipped Windows/default-suite test.
assert.equal(process.platform, "linux", "BACKUP_ROOT_TEST_REQUIRES_LINUX");
assert.equal(process.geteuid(), 0, "BACKUP_ROOT_TEST_REQUIRES_UID_0");

test("root coordinator reads an actual UID10001 child receipt without loosening secret ownership", async t => {
  const f = await backupWindowFixture(t);
  await chown(f.config.releaseDirectory, 10001, 10001);
  await chown(f.config.receiptDirectory, 10001, 10001);
  let receiptFile;
  const run = async args => {
    const output = await f.run(args);
    if (args.includes("scripts/production/backup-cli.mjs")) {
      const name = args.find(value => value.startsWith("MQ_BACKUP_RECEIPT=")).split("/").at(-1);
      receiptFile = join(f.config.receiptDirectory, name);
      await unlink(receiptFile);
      await new Promise((accept, reject) => {
        const child = spawn(process.execPath, ["-e",
          "require('node:fs').writeFileSync(process.argv[1],process.argv[2],{flag:'wx',mode:0o600})", receiptFile, output],
        { uid: 10001, gid: 10001, stdio: "ignore", env: {} });
        child.once("error", reject);
        child.once("exit", code => code === 0 ? accept() : reject(new Error("UID10001_RECEIPT_WRITE_FAILED")));
      });
      assert.equal((await lstat(receiptFile)).uid, 10001);
    }
    return output;
  };
  const result = await runBackupWindow(f.config, { run });
  assert.equal(result.completed, true);
  assert.deepEqual(f.events, ["stop", "pause", "backup", "resume", "start"]);
  assert.equal((await lstat(join(f.config.receiptDirectory, "latest.json"))).uid, 0);
  assert.equal(JSON.parse(await readFile(join(f.config.receiptDirectory, "latest.json"))).snapshotId, result.snapshotId);
  await assert.rejects(readDeploymentFile(receiptFile, { secret: true }), { message: "DEPLOYMENT_RUNTIME_CONFIG_REJECTED" });
  assert.equal((await readBackupReceipt(receiptFile)).verified, true);

  await chown(receiptFile, 10002, 10002);
  await assert.rejects(readBackupReceipt(receiptFile), { message: "BACKUP_WINDOW_RECEIPT_REJECTED" });
  await chown(receiptFile, 10001, 10001);
  await chmod(receiptFile, 0o644);
  await assert.rejects(readBackupReceipt(receiptFile), { message: "BACKUP_WINDOW_RECEIPT_REJECTED" });
  await chmod(receiptFile, 0o600);
  const secondLink = join(f.config.receiptDirectory, "second-link");
  await link(receiptFile, secondLink);
  await assert.rejects(readBackupReceipt(receiptFile), { message: "BACKUP_WINDOW_RECEIPT_REJECTED" });
  await unlink(secondLink);
  const symbolic = join(f.config.receiptDirectory, "symbolic-link");
  await symlink(receiptFile, symbolic);
  await assert.rejects(readBackupReceipt(symbolic), { message: "BACKUP_WINDOW_RECEIPT_REJECTED" });
  await unlink(symbolic);
});
