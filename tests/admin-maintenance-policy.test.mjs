import assert from "node:assert/strict";
import test from "node:test";
import { parseMaintenanceArguments, validateMaintenanceTarget, maintenanceConfirmation, assertMaintenanceIdentity } from "../scripts/admin/maintenance-policy.mjs";

const userId = "10000000-0000-4000-8000-000000000001";
const goodIdentity = {
  database: "mq_test_admin_probe", role: "mq_maintenance_probe", superuser: false, createdb: false, createrole: false,
  replication: false, bypassrls: false, hasMembership: false, ownsObjects: false, canCreateSchema: false, canCreateDatabaseObjects: false,
  canWriteAudit: false, canDeleteGrant: false, canTruncateGrant: false, canMigrate: false, canMaintainGrant: true, canResetPassword: true,
};

test("maintenance CLI requires explicit target, operation and exact optimistic identity", () => {
  assert.deepEqual(parseMaintenanceArguments(["--database", "mq_test_admin_probe", "--operation", "init", "--username", "Synthetic_Admin"]),
    { database: "mq_test_admin_probe", operation: "init", username: "synthetic_admin" });
  assert.deepEqual(parseMaintenanceArguments(["--database", "mq_test_admin_probe", "--operation", "revoke", "--user-id", userId, "--expected-version", "0"]),
    { database: "mq_test_admin_probe", operation: "revoke", userId, expectedVersion: 0 });
  for (const extra of [["--password", "synthetic-secret"], ["--yes", "true"], ["--url", "postgresql://secret"], ["--operation", "init"]]) {
    assert.throws(() => parseMaintenanceArguments(["--database", "mq_test_admin_probe", "--operation", "init", "--username", "synthetic_admin", ...extra]), /INVALID_ARGUMENTS/);
  }
  for (const version of ["-1", "01", "1.5", "2147483647", "Infinity"]) {
    assert.throws(() => parseMaintenanceArguments(["--database", "mq_test_admin_probe", "--operation", "reset-password", "--user-id", userId, "--expected-version", version]), /INVALID_ARGUMENTS/);
  }
  assert.equal(maintenanceConfirmation({ database: "mq_test_admin_probe", operation: "revoke", userId }), `REVOKE mq_test_admin_probe ${userId}`);
});

test("maintenance targets refuse remote hosts, owners, URL overrides and database mismatch without leaking values", () => {
  const good = "postgresql://mq_maintenance_probe:synthetic-only@127.0.0.1:55433/mq_test_admin_probe";
  assert.equal(validateMaintenanceTarget(good, "mq_test_admin_probe").pathname, "/mq_test_admin_probe");
  for (const bad of [good.replace("127.0.0.1", "remote.example"), good.replace("mq_maintenance_probe:", "mq_test:"),
    good.replace("mq_maintenance_probe:", "postgres:"), good.replace(":synthetic-only", ""), `${good}?options=override`, `${good}#ignored`,
    good.replace("/mq_test_admin_probe", "/mq_development")]) {
    assert.throws(() => validateMaintenanceTarget(bad, "mq_test_admin_probe"), error => error.message === "INVALID_MAINTENANCE_TARGET");
  }
});

test("maintenance preflight rejects owner/DDL/audit mutation privileges and incomplete maintenance identity", () => {
  assert.doesNotThrow(() => assertMaintenanceIdentity(goodIdentity, goodIdentity.database));
  for (const key of ["superuser", "createdb", "createrole", "replication", "bypassrls", "hasMembership", "ownsObjects", "canCreateSchema",
    "canCreateDatabaseObjects", "canWriteAudit", "canDeleteGrant", "canTruncateGrant", "canMigrate"]) {
    assert.throws(() => assertMaintenanceIdentity({ ...goodIdentity, [key]: true }, goodIdentity.database), /MAINTENANCE_IDENTITY_REJECTED/);
  }
  for (const key of ["canMaintainGrant", "canResetPassword"]) {
    assert.throws(() => assertMaintenanceIdentity({ ...goodIdentity, [key]: false }, goodIdentity.database), /MAINTENANCE_IDENTITY_REJECTED/);
  }
  assert.throws(() => assertMaintenanceIdentity({ ...goodIdentity, role: "mq_test" }, goodIdentity.database), /MAINTENANCE_IDENTITY_REJECTED/);
  assert.throws(() => assertMaintenanceIdentity(goodIdentity, "different_database"), /MAINTENANCE_IDENTITY_REJECTED/);
  assert.throws(() => assertMaintenanceIdentity({ ...goodIdentity, superuser: undefined }, goodIdentity.database), /MAINTENANCE_IDENTITY_REJECTED/);
});
