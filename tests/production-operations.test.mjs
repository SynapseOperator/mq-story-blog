import test from "node:test";
import assert from "node:assert/strict";
import { assessOperations } from "../scripts/production/operations-check.mjs";

const healthy = () => ({ freeBytes: 10 * 1024 ** 3, reserveBytes: 8 * 1024 ** 3,
  inodes: 1000, freeInodes: 500, freeMemoryBytes: 1024 ** 3, loadPerCpu: 0.5,
  certificateDays: 40, backupAgeHours: 2,
  services: ["app", "postgres", "proxy"].map(name => ({ name, running: true, oom: false, health: "healthy", exposed: name === "proxy", memoryPercent: 30 })) });
test("operations accepts healthy isolated services and recent verified backup", () => assert.equal(assessOperations(healthy()).ok, true));
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
