import assert from "node:assert/strict";
import { posix } from "node:path";
import { URL } from "node:url";
import { sha256, TARGETS } from "./bundle.mjs";
import { planRelease } from "./deploy.mjs";
import { validateDeploymentConfig } from "../production/database-config.mjs";

const reserve = 8 * 1024 ** 3;
const actions = Object.freeze({
  bootstrap: ["preflight", "postgres", "bootstrap", "migrate", "provision", "keys", "audit", "volumes-init", "media-init", "app", "health", "receipt"],
  upgrade: ["preflight", "close-ingress", "stop-app", "migrate", "provision", "audit", "app", "health", "receipt"],
  rollback: ["preflight", "close-ingress", "stop-app", "audit", "app", "health", "receipt"],
  activate: ["preflight", "audit", "app", "health", "open-ingress", "https", "receipt"],
});
const disabled = Object.freeze({ auth: false, media: false, publishing: false, comments: false });

function featureFlags(value = disabled) {
  assert.deepEqual(Object.keys(value).sort(), Object.keys(disabled).sort(), "PRODUCTION_FEATURES_REJECTED");
  assert.ok(Object.values(value).every(item => typeof item === "boolean"), "PRODUCTION_FEATURES_REJECTED");
  return { ...value };
}

function productionConfig(input) {
  assert.deepEqual(Object.keys(input ?? {}).sort(), ["database", "deploymentId", "environment", "media", "origin", "version"],
    "PRODUCTION_CONFIG_REJECTED");
  const config = validateDeploymentConfig(input);
  assert.equal(config.environment, "production", "PRODUCTION_TARGET_REQUIRED");
  assert.equal(config.database.name, "mq_production", "PRODUCTION_TARGET_REQUIRED");
  const origin = new URL(config.origin);
  assert.ok(origin.protocol === "https:" && origin.origin === config.origin && !origin.username && !origin.password,
    "PRODUCTION_HTTPS_REQUIRED");
  assert.deepEqual(Object.keys(config.media ?? {}).sort(), ["minFreeBytes", "root"], "PRODUCTION_MEDIA_REJECTED");
  assert.ok(typeof config.media.root === "string" && posix.isAbsolute(config.media.root)
    && config.media.root !== "/" && posix.normalize(config.media.root) === config.media.root
    && !/[\0\r\n]/.test(config.media.root), "PRODUCTION_MEDIA_REJECTED");
  assert.ok(Number.isSafeInteger(config.media.minFreeBytes) && config.media.minFreeBytes >= reserve
    && config.media.minFreeBytes <= 16 * 1024 ** 3, "PRODUCTION_DISK_RESERVE_REQUIRED");
  // The file manifest contains no credentials or operator-supplied SQL roles.
  // Identity names are derived again by the existing database tools.
  return globalThis.structuredClone(input);
}

function releaseContract(release, candidateManifestSha256) {
  assert.match(candidateManifestSha256 ?? "", /^[a-f0-9]{64}$/, "PRODUCTION_CANDIDATE_DIGEST_REQUIRED");
  assert.ok(release?.version === 1 && release.platform === "linux/amd64", "PRODUCTION_RELEASE_REJECTED");
  assert.match(release.sourceSha ?? "", /^[a-f0-9]{40}$/, "PRODUCTION_SOURCE_REJECTED");
  assert.ok(release.gate?.kind === "reviewed-main" && release.gate.sourceSha === release.sourceSha,
    "PRODUCTION_REVIEWED_CANDIDATE_REQUIRED");
  assert.deepEqual(Object.keys(release.images ?? {}).sort(), [...TARGETS].sort(), "PRODUCTION_IMAGES_REQUIRED");
  for (const target of TARGETS) assert.match(release.images[target]?.indexDigest ?? "", /^sha256:[a-f0-9]{64}$/,
    "PRODUCTION_IMAGE_DIGEST_REQUIRED");
  const migrations = release.compatibility?.migrations;
  assert.ok(Array.isArray(migrations) && migrations.length === 9, "PRODUCTION_MIGRATION_REVIEW_REQUIRED");
  assert.equal(new Set(migrations.map(item => item.name)).size, 9, "PRODUCTION_MIGRATION_REVIEW_REQUIRED");
  for (const item of migrations) {
    assert.match(item.name ?? "", /^[a-zA-Z0-9_]+$/, "PRODUCTION_MIGRATION_REVIEW_REQUIRED");
    assert.match(item.sha256 ?? "", /^[a-f0-9]{64}$/, "PRODUCTION_MIGRATION_REVIEW_REQUIRED");
  }
}

function frozenPlan(payload) {
  const snapshot = globalThis.structuredClone(payload);
  const plan = { ...snapshot, planId: sha256(JSON.stringify(snapshot)) };
  function freeze(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  freeze(plan);
  return plan;
}

function receiptMatches(receipt, { config, release, candidateManifestSha256, action, planId, features, publicIngress }) {
  assert.ok(receipt?.version === 1 && receipt.verified === true, "PRODUCTION_RECEIPT_REQUIRED");
  assert.ok(Object.hasOwn(actions, receipt.action), "PRODUCTION_RECEIPT_REJECTED");
  assert.equal(receipt.deploymentId, config.deploymentId, "PRODUCTION_RECEIPT_REJECTED");
  assert.equal(receipt.sourceSha, release.sourceSha, "PRODUCTION_RECEIPT_REJECTED");
  assert.deepEqual(receipt.release, release, "PRODUCTION_RECEIPT_REJECTED");
  assert.match(receipt.candidateManifestSha256 ?? "", /^[a-f0-9]{64}$/, "PRODUCTION_RECEIPT_REJECTED");
  assert.match(receipt.planId ?? "", /^[a-f0-9]{64}$/, "PRODUCTION_RECEIPT_REJECTED");
  assert.ok(Number.isFinite(Date.parse(receipt.completedAt)), "PRODUCTION_RECEIPT_REJECTED");
  featureFlags(receipt.features);
  assert.equal(typeof receipt.publicIngress, "boolean", "PRODUCTION_RECEIPT_REJECTED");
  if (receipt.action === "bootstrap") {
    assert.deepEqual(receipt.features, disabled, "PRODUCTION_RECEIPT_REJECTED");
    assert.equal(receipt.publicIngress, false, "PRODUCTION_RECEIPT_REJECTED");
  }
  if (receipt.action !== "activate") assert.equal(receipt.publicIngress, false, "PRODUCTION_RECEIPT_REJECTED");
  for (const [name, expected] of Object.entries({ candidateManifestSha256, action, planId, features, publicIngress })) {
    if (expected !== undefined) assert.deepEqual(receipt[name], expected, "PRODUCTION_RECEIPT_REJECTED");
  }
}

/** Offline plans are not authorizations. The host must independently verify the
 * candidate bytes, current GitHub gates, target ownership and secret files. */
export function planProductionBootstrap({ release, config: input, candidateManifestSha256, features }) {
  const config = productionConfig(input);
  releaseContract(release, candidateManifestSha256);
  assert.deepEqual(featureFlags(features), disabled, "PRODUCTION_BOOTSTRAP_FEATURES_DISABLED");
  return frozenPlan({ version: 1, action: "bootstrap", deploymentId: config.deploymentId,
    environment: config.environment, database: config.database.name, origin: config.origin,
    sourceSha: release.sourceSha, candidateManifestSha256, config, release, features: { ...disabled },
    publicIngress: false, migrationRollback: false, restoreOldSecrets: false, steps: actions.bootstrap });
}

export function planProductionChange({ release, currentRelease, config: input, backupReceipt, mode,
  candidateManifestSha256, features, now = Date.now() }) {
  const config = productionConfig(input);
  assert.ok(["upgrade", "rollback"].includes(mode), "PRODUCTION_ACTION_REJECTED");
  releaseContract(release, candidateManifestSha256);
  // Keep the existing exact migration/permission/config compatibility and
  // recent verified-backup requirements; never introduce a down migration.
  planRelease({ release, currentRelease, config, backupReceipt, mode, now });
  return frozenPlan({ version: 1, action: mode, deploymentId: config.deploymentId,
    environment: config.environment, database: config.database.name, origin: config.origin,
    sourceSha: release.sourceSha, candidateManifestSha256, config, release, currentRelease, backupReceipt,
    features: featureFlags(features), publicIngress: false, migrationRollback: false,
    restoreOldSecrets: false, steps: actions[mode] });
}

export function planProductionActivation({ currentRelease, config: input, receipt, features }) {
  const config = productionConfig(input);
  releaseContract(currentRelease, receipt?.candidateManifestSha256);
  receiptMatches(receipt, { config, release: currentRelease });
  assert.equal(receipt.publicIngress, false, "PRODUCTION_ACTIVATION_REQUIRES_CLOSED_RECEIPT");
  assert.ok(Date.parse(receipt.completedAt) <= Date.now(), "PRODUCTION_RECEIPT_REJECTED");
  return frozenPlan({ version: 1, action: "activate", deploymentId: config.deploymentId,
    environment: config.environment, database: config.database.name, origin: config.origin,
    sourceSha: currentRelease.sourceSha, candidateManifestSha256: receipt.candidateManifestSha256,
    config, release: currentRelease, priorReceipt: receipt, features: featureFlags(features),
    publicIngress: true, migrationRollback: false, restoreOldSecrets: false, steps: actions.activate });
}

/** An approval file is an explicit operator acknowledgement, not a signature or
 * a substitute for independent Review. Real host execution remains separately
 * authorized. Only a distinct activation plan can request a public entrance. */
export async function executeProductionPlan({ plan: input, approval, confirmation, execute, now = Date.now() }) {
  assert.ok(Object.hasOwn(actions, input?.action ?? ""), "PRODUCTION_ACTION_REJECTED");
  const { planId, ...payload } = input;
  assert.equal(planId, sha256(JSON.stringify(payload)), "PRODUCTION_PLAN_CHANGED");
  const plan = input.action === "bootstrap" ? planProductionBootstrap(input)
    : input.action === "activate" ? planProductionActivation({ currentRelease: input.release,
      config: input.config, receipt: input.priorReceipt, features: input.features })
      : planProductionChange({ ...input, mode: input.action, now });
  assert.deepEqual(input, plan, "PRODUCTION_PLAN_CHANGED");
  assert.deepEqual(Object.keys(approval ?? {}).sort(), ["action", "approvedAt", "deploymentId", "expiresAt", "planId", "sourceSha", "version"],
    "PRODUCTION_APPROVAL_REQUIRED");
  assert.equal(approval.version, 1, "PRODUCTION_APPROVAL_REQUIRED");
  for (const name of ["action", "deploymentId", "sourceSha", "planId"]) assert.equal(approval[name], plan[name], "PRODUCTION_APPROVAL_MISMATCH");
  const starts = Date.parse(approval.approvedAt), expires = Date.parse(approval.expiresAt);
  assert.ok(Number.isFinite(now) && Number.isFinite(starts) && Number.isFinite(expires)
    && starts <= now && now < expires && expires > starts && expires - starts <= 24 * 60 * 60 * 1000,
    "PRODUCTION_APPROVAL_EXPIRED");
  assert.equal(confirmation, `${plan.action}:${plan.deploymentId}:${plan.planId}`, "PRODUCTION_CONFIRMATION_REQUIRED");
  assert.equal(typeof execute, "function", "PRODUCTION_EXECUTOR_REQUIRED");
  const completed = [];
  let mutationStarted = false, step = "preflight", receipt;
  try {
    for (step of plan.steps) {
      // Mark before invocation: a command can partially change its own target
      // before throwing. Preflight is read-only and must never trigger cleanup.
      if (!["preflight", "audit", "health", "https"].includes(step)) mutationStarted = true;
      const result = await execute(step, plan);
      assert.notEqual(result, false, "PRODUCTION_STEP_FAILED");
      if (["preflight", "health", "https"].includes(step)) assert.equal(result, true, "PRODUCTION_PROBE_FAILED");
      if (step === "receipt") {
        receiptMatches(result, plan);
        receipt = result;
      }
      completed.push(step);
    }
    return { applied: true, action: plan.action, deploymentId: plan.deploymentId,
      sourceSha: plan.sourceSha, completed, receipt };
  } catch {
    if (!mutationStarted) throw new Error(step === "preflight"
      ? "PRODUCTION_PREFLIGHT_FAILED_NO_CHANGES" : "PRODUCTION_VALIDATION_FAILED_NO_CHANGES");
    let contained = true;
    for (const action of ["close-ingress", "stop-app"]) {
      try { if (await execute(action, plan) === false) contained = false; }
      catch { contained = false; }
    }
    const failure = new Error(contained ? "PRODUCTION_FAILED_INGRESS_CLOSED" : "PRODUCTION_FAILED_CONTAINMENT_UNCONFIRMED");
    failure.phase = step;
    failure.completed = completed;
    throw failure;
  }
}
