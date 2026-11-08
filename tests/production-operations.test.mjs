import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { assessOperations, collectOperations, readBackupAge } from "../scripts/production/operations-check.mjs";

const execute = promisify(execFile);

const healthy = () => ({ freeBytes: 10 * 1024 ** 3, reserveBytes: 8 * 1024 ** 3,
  inodes: 1000, freeInodes: 500, freeMemoryBytes: 1024 ** 3, loadPerCpu: 0.5,
  certificateDays: 40, httpAvailable: true, backupAgeHours: 2,
  services: ["app", "postgres", "proxy"].map(name => ({ name, running: true, oom: false, health: "healthy", exposed: name === "proxy", memoryPercent: 30 })) });
test("operations accepts healthy isolated services and recent verified backup", () => assert.equal(assessOperations(healthy()).ok, true));
test("a healthy TLS socket with an unavailable application still alerts", () => {
  assert.deepEqual(assessOperations({ ...healthy(), httpAvailable: false }).failures, ["HTTPS_UNAVAILABLE"]);
});
test("missing backup, failed TLS and disk/inode pressure produce actionable non-success", () => {
  const result = assessOperations({ ...healthy(), freeBytes: 10, freeInodes: 1, certificateDays: NaN, backupAgeHours: NaN });
  assert.deepEqual(result.failures, ["DISK_RESERVE_LOW", "INODES_LOW", "TLS_EXPIRY_OR_VERIFICATION_FAILED", "BACKUP_MISSING_OR_STALE"]);
});
test("host/container pressure, OOM and accidental database publication are not healthy", () => {
  const sample = healthy(); Object.assign(sample, { freeMemoryBytes: 1, loadPerCpu: 2 });
  Object.assign(sample.services[1], { exposed: true, oom: true, memoryPercent: 95 });
  assert.deepEqual(assessOperations(sample).failures, ["HOST_MEMORY_LOW", "HOST_LOAD_HIGH", "POSTGRES_UNHEALTHY", "POSTGRES_PORT_EXPOSED", "POSTGRES_MEMORY_HIGH"]);
});
test("duplicate or missing service, future or stale backup timestamps fail", () => {
  const sample = healthy(); sample.services.pop(); sample.services.push(sample.services[0]); sample.backupAgeHours = -2;
  assert.deepEqual(assessOperations(sample).failures, ["BACKUP_MISSING_OR_STALE", "APP_UNHEALTHY", "PROXY_UNHEALTHY"]);
  assert.ok(assessOperations({ ...healthy(), backupAgeHours: 27 }).failures.includes("BACKUP_MISSING_OR_STALE"));
});

test("offsite freshness requires the exact backend and repository, not another recent receipt", async () => {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, "mq-monitor-receipt-"));
  const receiptPath = join(directory, "receipt.json"), deploymentId = randomUUID(), now = Date.now();
  const target = { receiptPath, deploymentId, expectedBackend: "s3", expectedRepositoryId: "a".repeat(64) };
  const receipt = { verified: true, deploymentId, backend: "s3", repositoryId: target.expectedRepositoryId,
    snapshotId: "b".repeat(64), completedAt: new Date(now - 3600000).toISOString() };
  try {
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    assert.equal(await readBackupAge(target, now), 1);
    for (const replacement of [{ backend: "local" }, { repositoryId: "c".repeat(64) },
      { repositoryId: undefined }, { verified: false }, { deploymentId: randomUUID() }, { snapshotId: "latest" }]) {
      await writeFile(receiptPath, JSON.stringify({ ...receipt, ...replacement }));
      const age = await readBackupAge(target, now);
      assert.ok(Number.isNaN(age));
      assert.ok(assessOperations({ ...healthy(), backupAgeHours: age }).failures.includes("BACKUP_MISSING_OR_STALE"));
    }
    await writeFile(receiptPath, "not JSON");
    assert.ok(Number.isNaN(await readBackupAge(target, now)));
    assert.ok(Number.isNaN(await readBackupAge({ ...target, receiptPath: join(directory, "absent.json") }, now)));
    await assert.rejects(readBackupAge({ ...target, expectedRepositoryId: undefined }), { message: "OPS_BACKUP_TARGET_REJECTED" });
    await assert.rejects(readBackupAge({ ...target, expectedBackend: "local" }), { message: "OPS_BACKUP_TARGET_REJECTED" });
  } finally {
    assert.equal(dirname(resolve(directory)), parent); assert.match(basename(directory), /^mq-monitor-receipt-/);
    await rm(directory, { recursive: true });
  }
});

test("production monitoring refuses missing offsite identity before invoking Docker or HTTPS", async () => {
  const options = { project: "mq-production", deploymentId: randomUUID(), diskPath: tmpdir(), origin: "https://never-contact.invalid" };
  for (const expectedBackend of [undefined, "local"]) {
    await assert.rejects(collectOperations({ ...options, expectedBackend }), { message: "OPS_OFFSITE_BACKUP_TARGET_REQUIRED" });
  }
  await assert.rejects(collectOperations({ ...options, expectedBackend: "s3" }), { message: "OPS_BACKUP_TARGET_REJECTED" });
});

test("CLI probe failure for a valid deployment emits a fresh report accepted by the alert CLI", async () => {
  const deploymentId = randomUUID(), started = Date.now();
  const failure = await execute(process.execPath, ["scripts/production/operations-check.mjs"], {
    windowsHide: true, env: { ...process.env, MQ_OPS_DEPLOYMENT_ID: deploymentId,
      MQ_OPS_PROJECT: "invalid-project-private-value", MQ_OPS_ORIGIN: "https://never-contact.invalid" },
  }).then(() => assert.fail("expected nonzero"), error => error);
  assert.equal(failure.code, 1);
  assert.equal(failure.stderr.trim(), "MQ_OPERATIONS_CHECK_FAILED");
  const report = JSON.parse(failure.stdout);
  assert.equal(report.deploymentId, deploymentId); assert.equal(report.ok, false);
  assert.deepEqual(report.failures, ["OPERATIONS_CHECK_FAILED"]);
  assert.ok(Date.parse(report.checkedAt) >= started);
  assert.doesNotMatch(failure.stdout + failure.stderr, /invalid-project-private-value|never-contact/);
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, "mq-monitor-alert-"));
  try {
    const reportFile = join(directory, "report.json");
    await writeFile(reportFile, failure.stdout, { mode: 0o600 });
    const result = await execute(process.execPath, ["scripts/production/alert-webhook.mjs"], {
      windowsHide: true, env: { ...process.env, MQ_ALERT_REPORT_FILE: reportFile, MQ_ALERT_WEBHOOK_URL_FILE: "not-read-in-dry-run" },
    });
    const preview = JSON.parse(result.stdout);
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.alert.failures, ["OPERATIONS_CHECK_FAILED"]);
    assert.equal(preview.alert.deploymentId, deploymentId);
  } finally {
    assert.equal(dirname(resolve(directory)), parent); assert.match(basename(directory), /^mq-monitor-alert-/);
    await rm(directory, { recursive: true });
  }
});

test("CLI invalid deployment ID produces no fabricated notification report", async () => {
  const failure = await execute(process.execPath, ["scripts/production/operations-check.mjs"], {
    windowsHide: true, env: { ...process.env, MQ_OPS_DEPLOYMENT_ID: "invalid-private-target", MQ_OPS_PROJECT: "mq-test" },
  }).then(() => assert.fail("expected nonzero"), error => error);
  assert.equal(failure.code, 1);
  assert.equal(failure.stdout, ""); assert.equal(failure.stderr.trim(), "MQ_OPERATIONS_CHECK_FAILED");
});
