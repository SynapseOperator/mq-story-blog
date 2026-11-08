import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readS3CredentialsEnvironment, restic, runBackupTool } from "../../scripts/production/backup-tools.mjs";

// Invoked only by the no-egress Docker fixture. No provider account is used.
let phase = "input";
try {
  assert.equal(process.env.MQ_SYNTHETIC_LAB, "true");
  assert.match(process.env.MQ_LAB_OSS_PROJECT, /^mq-oss-[a-f0-9]{32}$/);
  const repository = `s3:https://oss-cn-hongkong.aliyuncs.com/mq-lab/${process.env.MQ_LAB_OSS_PROJECT}`;
  const passwordFile = "/run/secrets/restic-password", credentialsFile = "/run/s3/s3_credentials";
  const region = "oss-cn-hongkong";
  const common = ["--repo", repository, "--password-file", passwordFile, "--no-cache",
    "-o", `s3.region=${region}`, "-o", "s3.bucket-lookup=dns"];
  const env = { ...await readS3CredentialsEnvironment(credentialsFile), GOMAXPROCS: "2" };
  // Only this fresh private fixture is explicitly initialized. The production
  // wrapper continues to reject automatic S3 init.
  phase = "initialize";
  await runBackupTool("restic", [...common, "init", "--repository-version", "2"], { env });
  phase = "repository-identity";
  const expectedRepositoryId = JSON.parse(await runBackupTool("restic", [...common, "cat", "config"], { env })).id;
  const initialization = JSON.parse(await readFile("/run/s3/transport.json", "utf8"));
  assert.ok(initialization.headBucketDenied > 0, "RESTIC_INIT_BUCKET_HEAD_NOT_TESTED");
  const options = { backend: "s3", repository, passwordFile, expectedRepositoryId,
    s3: { region, credentialsFile }, cwd: "/work" };
  await mkdir("/work/payload", { mode: 0o700 });
  const content = "MQ synthetic backup transport. No personal stories or credentials.\n";
  await writeFile("/work/payload/story.txt", content, { mode: 0o600, flag: "wx" });
  phase = "backup";
  const backup = await restic(["backup", "--json", "--host", `mq-${randomUUID()}`, "--tag", "mq-deployment-v1", "payload"], options);
  const summary = backup.trim().split("\n").map(line => JSON.parse(line)).find(row => row.message_type === "summary");
  assert.match(summary.snapshot_id, /^[a-f0-9]{64}$/);
  phase = "integrity";
  await restic(["check", "--read-data"], options);
  await mkdir("/work/restored", { mode: 0o700 });
  phase = "restore";
  await restic(["restore", `${summary.snapshot_id}:/payload`, "--target", "/work/restored", "--verify"], options);
  assert.equal(await readFile("/work/restored/story.txt", "utf8"), content);
  phase = "negative-controls";
  await assert.rejects(restic(["check", "--read-data"], { ...options, expectedRepositoryId: "0".repeat(64) }));
  await assert.rejects(restic(["check", "--read-data"], { ...options, passwordFile: "/run/secrets/wrong-password" }));
  const operations = JSON.parse(await readFile("/run/s3/transport.json", "utf8"));
  assert.equal(operations.headBucketDenied, initialization.headBucketDenied, "DAILY_OPERATIONS_REQUIRE_HEAD_BUCKET");
  assert.equal(operations.unscopedListsDenied, 0);
  assert.equal(operations.nonLockDeletesDenied, 0);
  console.log("PASS OSS transport: real Restic encrypted backup, full check and isolated file restore; wrong identity/password refused");
} catch {
  console.error(`OSS_TRANSPORT_ACTION_FAILED phase=${phase}; child diagnostics withheld`);
  process.exitCode = 1;
}
