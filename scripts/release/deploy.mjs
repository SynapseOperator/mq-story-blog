import assert from "node:assert/strict";
import { URL } from "node:url";
import { sha256, TARGETS } from "./bundle.mjs";
import { validateDeploymentConfig } from "../production/database-config.mjs";

/** Offline deployment planning. It neither grants GitHub approval nor connects
 * to a host. Only the reviewed, data-only 010 addition can extend migrations. */
export function planRelease({ release, currentRelease, config: input, backupReceipt, mode = "upgrade", now = Date.now() }) {
  const config = validateDeploymentConfig(input);
  assert.ok(["upgrade", "rollback"].includes(mode), "RELEASE_MODE_REJECTED");
  for (const item of [release, currentRelease]) {
    assert.ok(item?.version === 1 && item.platform === "linux/amd64", "RELEASE_MANIFEST_REJECTED");
    assert.match(item.sourceSha ?? "", /^[a-f0-9]{40}$/, "RELEASE_SOURCE_REJECTED");
    for (const target of TARGETS) assert.match(item.images?.[target]?.indexDigest ?? "", /^sha256:[a-f0-9]{64}$/, "RELEASE_IMAGE_DIGEST_REQUIRED");
    assert.ok([9, 10].includes(item.compatibility?.migrations?.length), "RELEASE_MIGRATION_REVIEW_REQUIRED");
    if (item.compatibility.migrations.length === 10) {
      assert.equal(item.compatibility.migrations[9].name, "202611120010_seven_story_stars", "RELEASE_MIGRATION_REVIEW_REQUIRED");
      assert.match(item.compatibility.migrations[9].sha256 ?? "", /^[a-f0-9]{64}$/, "RELEASE_MIGRATION_REVIEW_REQUIRED");
    }
  }
  const comparable = [release, currentRelease].map(item => globalThis.structuredClone(item.compatibility));
  if (mode === "upgrade") {
    if (comparable[0].migrations.length === 10 && comparable[1].migrations.length === 9) {
      // The old nine checksums and order remain exact. No removal, rewrite or
      // arbitrary future migration is allowed; 10 -> 9 rollback stays closed.
      assert.deepEqual(comparable[0].migrations.slice(0, 9), comparable[1].migrations,
        "RELEASE_ROLLBACK_OR_MIGRATION_INCOMPATIBLE");
      comparable[0].migrations.pop();
    }
    // Reviewed executor fixes can advance without changing persisted data or
    // runtime contracts. The host still verifies every source hash against the
    // candidate; rollback retains the previous exact-compatibility rule.
    for (const name of ["scripts/release/production-plan.mjs", "scripts/release/production-host.mjs"]) {
      for (const compatibility of comparable) {
        assert.match(compatibility.contracts?.[name] ?? "", /^[a-f0-9]{64}$/, "RELEASE_EXECUTOR_CONTRACT_REQUIRED");
        compatibility.contracts[name] = "reviewed-upgrade-executor";
      }
    }
  }
  assert.deepEqual(comparable[0], comparable[1], "RELEASE_ROLLBACK_OR_MIGRATION_INCOMPATIBLE");
  assert.ok(backupReceipt?.verified && backupReceipt.deploymentId === config.deploymentId,
    "RELEASE_VERIFIED_BACKUP_REQUIRED");
  assert.match(backupReceipt.snapshotId ?? "", /^[a-f0-9]{64}$/, "RELEASE_VERIFIED_BACKUP_REQUIRED");
  const age = now - Date.parse(backupReceipt.completedAt);
  assert.ok(Number.isFinite(age) && age >= 0 && age <= 26 * 60 * 60 * 1000, "RELEASE_BACKUP_STALE");
  const origin = new URL(config.origin);
  assert.equal(origin.protocol, "https:", "RELEASE_HTTPS_REQUIRED");
  const plan = { version: 1, mode, deploymentId: config.deploymentId, environment: config.environment,
    database: config.database.name, origin: config.origin, platform: release.platform,
    sourceSha: release.sourceSha, previousSourceSha: currentRelease.sourceSha,
    images: Object.fromEntries(TARGETS.map(target => [target, release.images[target].indexDigest])),
    previousImages: Object.fromEntries(TARGETS.map(target => [target, currentRelease.images[target].indexDigest])),
    backupSnapshot: backupReceipt.snapshotId,
    steps: ["close-ingress", "stop-app", ...(mode === "upgrade" ? ["migrate", "provision"] : []),
      "audit", "start-app", "health", "open-ingress"],
    productionApplyAllowed: false, migrationRollback: false, restoreOldSecrets: false };
  return { ...plan, planId: sha256(JSON.stringify(plan)) };
}

/** Only the isolated container laboratory may execute this plan. The runner
 * reuses Compose and database-cli with their existing identity/target checks;
 * it cannot add arbitrary steps. A failed upgrade leaves ingress closed. */
export async function applySyntheticRelease({ plan, confirmation, execute }) {
  assert.ok(plan?.environment === "staging" && plan.productionApplyAllowed === false
    && plan.migrationRollback === false && plan.restoreOldSecrets === false, "RELEASE_PRODUCTION_APPLY_NOT_AUTHORIZED");
  assert.equal(confirmation, plan.deploymentId, "RELEASE_TARGET_CONFIRMATION_REQUIRED");
  assert.match(plan.database ?? "", /^mq_staging_[a-f0-9]{32}$/, "RELEASE_SYNTHETIC_TARGET_REQUIRED");
  const url = new URL(plan.origin);
  assert.ok(url.protocol === "https:" && (url.hostname === "localhost" || url.hostname.endsWith(".localhost")), "RELEASE_SYNTHETIC_TARGET_REQUIRED");
  assert.deepEqual(plan.steps, ["close-ingress", "stop-app", ...(plan.mode === "upgrade" ? ["migrate", "provision"] : []),
    "audit", "start-app", "health", "open-ingress"], "RELEASE_PLAN_REJECTED");
  const { planId, ...payload } = plan;
  assert.equal(sha256(JSON.stringify(payload)), planId, "RELEASE_PLAN_CHANGED");
  const completed = [];
  try {
    for (const step of plan.steps) {
      const result = await execute(step, plan);
      if (step === "health") assert.equal(result, true, "RELEASE_HEALTH_FAILED");
      completed.push(step);
    }
    return { applied: true, synthetic: true, productionDeployed: false, mode: plan.mode,
      deploymentId: plan.deploymentId, sourceSha: plan.sourceSha, completed };
  } catch {
    // No best-effort success: report containment failure separately so an
    // operator cannot mistake a failing Docker daemon for a closed entrance.
    const closed = await Promise.allSettled(["close-ingress", "stop-app"].map(async step => execute(step, plan)));
    if (closed.some(result => result.status === "rejected")) throw new Error("RELEASE_FAILED_CONTAINMENT_UNCONFIRMED");
    throw new Error("RELEASE_FAILED_INGRESS_CLOSED");
  }
}
