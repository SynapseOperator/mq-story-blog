import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPrivateChild, digest } from "../media/backup-files.mjs";
import { initializeBackupRepository, restic, retentionDryRun, runBackupTool } from "./backup-tools.mjs";

// Real Restic encryption/restore/failure checks. The operations image supplies
// the pinned binary; no database, personal file or remote repository is used.
let stage = "create private temporary fixture";
const report = { restic: "0.19.1", platform: process.platform, cases: [], cleanup: false };
const passed = name => { report.cases.push(name); console.log(`PASS ${name}`); };
async function main() {
  const directory = await createPrivateChild(tmpdir(), "mq-restic-fixture-");
  const repository = join(directory, "repository"), workspace = join(directory, "workspace");
  const passwordFile = join(directory, "password"), wrongPasswordFile = join(directory, "wrong-password");
  for (const path of [repository, workspace, join(workspace, "payload")]) await mkdir(path, { mode: 0o700 });
  await writeFile(passwordFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  await writeFile(wrongPasswordFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const bytes = randomBytes(256 * 1024);
  await writeFile(join(workspace, "payload", "synthetic.bin"), bytes, { mode: 0o600 });
  const options = { repository, passwordFile };
  const deploymentId = randomUUID();
  const backupArgs = ["backup", "--json", "--host", `mq-${deploymentId}`, "--tag", "mq-deployment-v1", "payload"];
  try {
    stage = "explicit encrypted repository initialization";
    const initialized = await initializeBackupRepository(options);
    assert.equal(initialized.encrypted, true);
    await assert.rejects(initializeBackupRepository(options));
    passed("explicit encrypted repository initialization refuses existing contents");

    stage = "backup and repeat without losing snapshots";
    const snapshotIds = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Production exports have a different absolute directory on each run.
      // Retention must group by deployment host/tags, not this varying path.
      const current = attempt ? await createPrivateChild(directory, "another-export-") : workspace;
      if (attempt) {
        await mkdir(join(current, "payload"), { mode: 0o700 });
        await writeFile(join(current, "payload", "synthetic.bin"), bytes, { mode: 0o600 });
      }
      const output = await restic(backupArgs, { ...options, cwd: current });
      const summary = output.trim().split("\n").map(row => JSON.parse(row)).find(row => row.message_type === "summary");
      assert.match(summary?.snapshot_id ?? "", /^[a-f0-9]{64}$/);
      snapshotIds.push(summary.snapshot_id);
    }
    assert.equal(new Set(snapshotIds).size, 3);
    await restic(["check", "--read-data"], options);
    passed("repeated backup produces explicit snapshots and full data check succeeds");

    stage = "retention plans across random export paths without deleting snapshots";
    const before = (await readdir(join(repository, "snapshots"))).sort();
    const plan = await retentionDryRun({ ...options, deploymentId });
    assert.deepEqual(plan.policy, { daily: 7, weekly: 8 });
    assert.equal(plan.dryRun, true); assert.equal(plan.deleted, 0);
    // Restic also keeps the oldest available snapshot when history is shorter
    // than the requested daily/weekly periods. The middle one is a candidate.
    assert.deepEqual(plan.keep.sort(), [snapshotIds[0], snapshotIds[2]].sort());
    assert.deepEqual(plan.candidates, [snapshotIds[1]]);
    assert.deepEqual((await readdir(join(repository, "snapshots"))).sort(), before);
    const other = await retentionDryRun({ ...options, deploymentId: randomUUID() });
    assert.deepEqual(other.keep, []); assert.deepEqual(other.candidates, []);
    passed("7 daily / 8 weekly retention is a read-only plan scoped to one deployment across differing paths");

    stage = "verified restore into fresh empty destination";
    const target = await createPrivateChild(directory, "restored-");
    await restic(["restore", `${snapshotIds[0]}:/payload`, "--target", target, "--verify"], options);
    assert.equal(digest(await readFile(join(target, "synthetic.bin"))), digest(bytes));
    if (process.platform !== "win32") assert.equal((await lstat(join(target, "synthetic.bin"))).mode & 0o777, 0o600);
    await assert.rejects(restic(["restore", `${snapshotIds[1]}:/payload`, "--target", target, "--verify"], options));
    passed("verified restore preserves bytes and private mode; existing destination cannot be overwritten");

    stage = "wrong password and missing snapshot";
    await assert.rejects(restic(["check", "--read-data"], { ...options, passwordFile: wrongPasswordFile }), { message: "BACKUP_RESTIC_FAILED" });
    const emptyTarget = await createPrivateChild(directory, "absent-");
    await assert.rejects(restic(["restore", `${"0".repeat(64)}:/payload`, "--target", emptyTarget, "--verify"], options));
    assert.deepEqual(await readdir(emptyTarget), []);
    passed("wrong repository password and nonexistent snapshot fail closed");

    stage = "authenticated data detects corruption and missing object";
    const shards = (await readdir(join(repository, "data"))).filter(name => /^[a-f0-9]{2}$/.test(name));
    let pack;
    for (const shard of shards) {
      const files = (await readdir(join(repository, "data", shard))).filter(name => /^[a-f0-9]{64}$/.test(name));
      if (files.length) { pack = join(repository, "data", shard, files[0]); break; }
    }
    assert.ok(pack, "A real encrypted data pack must exist");
    stage = "tampered encrypted pack is rejected";
    const original = await readFile(pack), tampered = Buffer.from(original);
    const originalMode = (await lstat(pack)).mode & 0o777;
    await chmod(pack, 0o600); // Deliberate corruption of this synthetic test-owned object only.
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    await writeFile(pack, tampered);
    await assert.rejects(restic(["check", "--read-data"], options), { message: "BACKUP_RESTIC_FAILED" });
    await writeFile(pack, original);
    await chmod(pack, originalMode);
    stage = "missing encrypted pack is rejected";
    const held = join(directory, "test-owned-pack");
    await rename(pack, held);
    await assert.rejects(restic(["check", "--read-data"], options), { message: "BACKUP_RESTIC_FAILED" });
    await rename(held, pack);
    stage = "repaired synthetic repository passes full check";
    await restic(["check", "--read-data"], options);
    passed("full repository check detects byte tampering and missing encrypted pack");

    stage = "interrupted native tool does not count as successful backup";
    // Terminate a genuine Restic process early. Any uncertain snapshot remains
    // unacknowledged; no success receipt is emitted and no unlock/prune follows.
    await assert.rejects(runBackupTool("restic", ["--repo", repository, "--password-file", passwordFile, "--no-cache", "check", "--read-data"],
      { timeoutMs: 1 }), { message: "BACKUP_TOOL_FAILED" });
    passed("interrupted native process returns failure, with no automatic unlock or destructive cleanup");
  } finally {
    // Exact directory created by this invocation, outside Git. Never glob or
    // recurse into an operator-selected repo; this is disposable test cleanup.
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}`));
    assert.match(directory.split(/[/\\]/).at(-1), /^mq-restic-fixture-[a-f0-9-]{36}$/);
    await rm(directory, { recursive: true }); report.cleanup = true;
  }
  console.log(JSON.stringify(report));
}
main().catch(() => { console.error(`BACKUP_TOOLS_TEST_FAILED at ${stage}; details withheld`); process.exitCode = 1; });
