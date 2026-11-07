import assert from "node:assert/strict";
import test from "node:test";
import { sha256, TARGETS } from "../scripts/release/bundle.mjs";
import { applySyntheticRelease } from "../scripts/release/deploy.mjs";
import { planProductionBootstrap, planProductionChange, planProductionActivation,
  executeProductionPlan } from "../scripts/release/production-plan.mjs";

const sourceSha = "a".repeat(40), previousSha = "b".repeat(40), digest = "c".repeat(64);
const disabled = { auth: false, media: false, publishing: false, comments: false };
function fixture() {
  const config = { version: 1, deploymentId: "a1234567-1234-4234-8234-123456789abc", environment: "production",
    database: { host: "postgres", port: 5432, name: "mq_production" }, origin: "https://synthetic.example.invalid",
    media: { root: "/var/lib/mq/media", minFreeBytes: 8 * 1024 ** 3 } };
  const release = { version: 1, sourceSha, platform: "linux/amd64", gate: { kind: "reviewed-main", sourceSha },
    compatibility: { migrations: Array.from({ length: 8 }, (_, index) => ({ name: `migration_00${index + 1}`, sha256: digest })),
      contracts: { schema: digest, permissions: digest } },
    images: Object.fromEntries(TARGETS.map(target => [target, { indexDigest: `sha256:${digest}` }])) };
  const currentRelease = { ...globalThis.structuredClone(release), sourceSha: previousSha,
    gate: { kind: "reviewed-main", sourceSha: previousSha } };
  return { config, release, currentRelease, candidateManifestSha256: digest,
    backupReceipt: { verified: true, deploymentId: config.deploymentId, snapshotId: "d".repeat(64), completedAt: new Date().toISOString() } };
}
function permission(plan, now = Date.now()) {
  return { approval: { version: 1, action: plan.action, planId: plan.planId, deploymentId: plan.deploymentId,
    sourceSha: plan.sourceSha, approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() },
  confirmation: `${plan.action}:${plan.deploymentId}:${plan.planId}`, now };
}
function receipt(plan) {
  return { version: 1, verified: true, planId: plan.planId, deploymentId: plan.deploymentId,
    sourceSha: plan.sourceSha, candidateManifestSha256: plan.candidateManifestSha256,
    completedAt: new Date().toISOString(), action: plan.action, features: plan.features,
    publicIngress: plan.publicIngress, release: plan.release };
}
function executor(calls, failures = {}) {
  return async (step, plan) => {
    calls.push(step);
    if (Object.hasOwn(failures, step)) {
      const failure = failures[step];
      if (failure instanceof Error) throw failure;
      return failure;
    }
    if (["preflight", "health", "https"].includes(step)) return true;
    if (step === "receipt") return receipt(plan);
  };
}

test("production bootstrap binds config and candidate, stays closed and never seeds an administrator", async () => {
  const input = fixture(), plan = planProductionBootstrap(input), calls = [];
  const result = await executeProductionPlan({ plan, ...permission(plan), execute: executor(calls) });
  assert.deepEqual(calls, ["preflight", "postgres", "bootstrap", "migrate", "provision", "keys", "audit",
    "volumes-init", "media-init", "app", "health", "receipt"]);
  assert.deepEqual(plan.features, disabled);
  assert.equal(plan.publicIngress, false);
  assert.equal(result.receipt.publicIngress, false);
  assert.equal(result.receipt.sourceSha, sourceSha);
  assert.equal(Object.hasOwn(result, "backupReceipt"), false);
  assert.equal(Object.hasOwn(result, "currentRelease"), false);
  assert.ok(!calls.includes("seed") && !calls.includes("admin-init") && !calls.includes("open-ingress"));
  input.config.database.host = "foreign";
  assert.equal(plan.config.database.host, "postgres", "Plan is a frozen snapshot of its admitted inputs");
  assert.throws(() => { plan.config.database.host = "foreign"; }, TypeError);
});

test("production planning rejects staging, wrong database, weak reserve, HTTP and extra secret fields", () => {
  for (const mutate of [
    input => { input.config.environment = "staging"; input.config.database.name = "mq_staging"; },
    input => { input.config.database.name = "mq_test"; },
    input => { input.config.media.minFreeBytes = 8 * 1024 ** 3 - 1; },
    input => { input.config.media.root = "/var/lib/../public"; },
    input => { input.config.origin = "http://synthetic.example.invalid"; },
    input => { input.config.origin += "/path"; },
    input => { input.config.AUTH_SECRET = "never-accepted"; },
    input => { input.features = { ...disabled, auth: true }; },
  ]) {
    const input = fixture(); mutate(input); assert.throws(() => planProductionBootstrap(input));
  }
});

test("all four image digests, eight migrations and reviewed candidate identity are required", () => {
  for (const mutate of [
    input => { input.candidateManifestSha256 = "not-a-digest"; },
    input => { input.release.sourceSha = "bad"; },
    input => { input.release.gate.sourceSha = previousSha; },
    input => { input.release.platform = "linux/arm64"; },
    input => { delete input.release.images.operations; },
    input => { input.release.images.app.indexDigest = "latest"; },
    input => { input.release.compatibility.migrations.pop(); },
    input => { input.release.compatibility.migrations[1].name = input.release.compatibility.migrations[0].name; },
  ]) {
    const input = fixture(); mutate(input); assert.throws(() => planProductionBootstrap(input));
  }
});

test("plan digest includes private target, source contracts, feature flags and backup identity", () => {
  const plan = planProductionChange({ ...fixture(), mode: "upgrade" });
  for (const mutate of [
    value => { value.config.media.root = "/different-private-root"; },
    value => { value.release.compatibility.contracts.schema = "e".repeat(64); },
    value => { value.features.comments = true; },
    value => { value.backupReceipt.snapshotId = "f".repeat(64); },
  ]) {
    const changed = globalThis.structuredClone(plan); mutate(changed);
    const { planId, ...payload } = changed;
    assert.notEqual(sha256(JSON.stringify(payload)), planId);
  }
});

test("tampered or reconstructed arbitrary steps cannot execute", async () => {
  const plan = planProductionBootstrap(fixture()), calls = [];
  const changed = { ...plan, sourceSha: previousSha };
  await assert.rejects(executeProductionPlan({ plan: changed, ...permission(plan), execute: executor(calls) }), /PLAN_CHANGED/);
  const payload = { ...plan }; delete payload.planId;
  const forbidden = { ...payload, steps: ["preflight", "delete-database"] };
  const forged = { ...forbidden, planId: sha256(JSON.stringify(forbidden)) };
  await assert.rejects(executeProductionPlan({ plan: forged, ...permission(forged), execute: executor(calls) }), /PLAN_CHANGED/);
  assert.deepEqual(calls, []);
});

test("approval must match action, deployment, exact plan and source within at most 24 hours", async () => {
  const plan = planProductionBootstrap(fixture()), admitted = permission(plan), calls = [];
  for (const change of [
    { action: "activate" }, { deploymentId: "other" }, { sourceSha: previousSha }, { planId: "e".repeat(64) },
    { approvedAt: new Date(admitted.now + 1000).toISOString() },
    { expiresAt: new Date(admitted.now - 1).toISOString() },
    { approvedAt: new Date(admitted.now - 86_400_001).toISOString() },
    { approvedAt: "not-time" }, { ignoredPrivilege: true },
  ]) await assert.rejects(executeProductionPlan({ plan, ...admitted,
    approval: { ...admitted.approval, ...change }, execute: executor(calls) }));
  await assert.rejects(executeProductionPlan({ plan, ...admitted, confirmation: plan.deploymentId,
    execute: executor(calls) }), /CONFIRMATION_REQUIRED/);
  assert.deepEqual(calls, []);
});

test("read-only preflight failure never stops any existing target", async () => {
  for (const failure of [false, new Error("private diagnostic must not escape")]) {
    const plan = planProductionBootstrap(fixture()), calls = [];
    await assert.rejects(executeProductionPlan({ plan, ...permission(plan), execute: executor(calls, { preflight: failure }) }),
      /^Error: PRODUCTION_PREFLIGHT_FAILED_NO_CHANGES$/);
    assert.deepEqual(calls, ["preflight"]);
  }
});

test("mutating failure closes only ingress/app and reports failed containment without deleting data", async () => {
  const plan = planProductionBootstrap(fixture()), calls = [];
  await assert.rejects(executeProductionPlan({ plan, ...permission(plan), execute: executor(calls,
    { migrate: new Error("private-password"), "close-ingress": false }) }), error => {
    assert.equal(error.message, "PRODUCTION_FAILED_CONTAINMENT_UNCONFIRMED");
    assert.equal(error.phase, "migrate");
    assert.ok(!JSON.stringify(error).includes("private-password"));
    return true;
  });
  assert.deepEqual(calls.slice(-2), ["close-ingress", "stop-app"]);
  assert.ok(!calls.includes("receipt") && !calls.includes("open-ingress"));
});

test("failed health or missing real receipt cannot complete a deployment", async () => {
  for (const failures of [{ health: false }, { receipt: undefined }, { receipt: { verified: true } }]) {
    const plan = planProductionBootstrap(fixture()), calls = [];
    await assert.rejects(executeProductionPlan({ plan, ...permission(plan), execute: executor(calls, failures) }), /INGRESS_CLOSED/);
    assert.deepEqual(calls.slice(-2), ["close-ingress", "stop-app"]);
  }
});

test("upgrade and rollback retain exact compatibility and fresh-backup requirements", () => {
  for (const mutate of [
    input => { input.currentRelease.compatibility.contracts.schema = "changed"; },
    input => { input.backupReceipt.verified = false; },
    input => { input.backupReceipt.deploymentId = "other"; },
    input => { input.backupReceipt.completedAt = "2020-01-01T00:00:00Z"; },
  ]) {
    const input = fixture(); mutate(input);
    for (const mode of ["upgrade", "rollback"]) assert.throws(() => planProductionChange({ ...input, mode }));
  }
});

test("application rollback never migrates, provisions, restores secrets or opens ingress", async () => {
  const plan = planProductionChange({ ...fixture(), mode: "rollback", features: { ...disabled, auth: true } }), calls = [];
  const result = await executeProductionPlan({ plan, ...permission(plan), execute: executor(calls) });
  assert.deepEqual(calls, ["preflight", "close-ingress", "stop-app", "audit", "app", "health", "receipt"]);
  assert.equal(result.receipt.publicIngress, false);
  assert.equal(plan.restoreOldSecrets, false); assert.equal(plan.migrationRollback, false);
  assert.equal(result.receipt.features.auth, true);
});

test("public activation needs a real matching receipt and a distinct approval bound to business flags", async () => {
  const input = fixture(), bootstrap = planProductionBootstrap(input), bootReceipt = receipt(bootstrap);
  const plan = planProductionActivation({ currentRelease: input.release, config: input.config, receipt: bootReceipt,
    features: { auth: true, media: true, publishing: false, comments: false } });
  const calls = [];
  await assert.rejects(executeProductionPlan({ plan, ...permission(bootstrap), execute: executor(calls) }), /APPROVAL_MISMATCH/);
  assert.deepEqual(calls, []);
  const result = await executeProductionPlan({ plan, ...permission(plan), execute: executor(calls) });
  assert.deepEqual(calls, ["preflight", "audit", "app", "health", "open-ingress", "https", "receipt"]);
  assert.equal(result.receipt.publicIngress, true);
  assert.deepEqual(result.receipt.features, plan.features);
  assert.notEqual(plan.planId, bootstrap.planId);
  for (const change of [{ sourceSha: previousSha }, { deploymentId: "other" }, { publicIngress: true }, { verified: false }]) {
    assert.throws(() => planProductionActivation({ currentRelease: input.release, config: input.config, receipt: { ...bootReceipt, ...change } }));
  }
});

test("activation audit failure preserves existing target; HTTPS failure closes the newly requested entrance", async () => {
  const input = fixture(), bootstrap = planProductionBootstrap(input);
  const plan = planProductionActivation({ currentRelease: input.release, config: input.config, receipt: receipt(bootstrap) });
  const auditCalls = [];
  await assert.rejects(executeProductionPlan({ plan, ...permission(plan), execute: executor(auditCalls,
    { audit: new Error("audit unavailable") }) }), /VALIDATION_FAILED_NO_CHANGES/);
  assert.deepEqual(auditCalls, ["preflight", "audit"]);
  const calls = [];
  await assert.rejects(executeProductionPlan({ plan, ...permission(plan), execute: executor(calls, { https: false }) }), /INGRESS_CLOSED/);
  assert.deepEqual(calls.slice(-2), ["close-ingress", "stop-app"]);
  assert.ok(!calls.includes("receipt"));
});

test("old synthetic apply still refuses production plans", async () => {
  const plan = planProductionBootstrap(fixture());
  await assert.rejects(applySyntheticRelease({ plan, confirmation: plan.deploymentId,
    execute() { assert.fail("Old production refusal must remain"); } }), /NOT_AUTHORIZED/);
});

test("an already public receipt cannot reactivate or change flags without a closed deployment plan", () => {
  const input = fixture(), plan = planProductionBootstrap(input), prior = receipt(plan);
  const active = { ...prior, action: "activate", publicIngress: true };
  assert.throws(() => planProductionActivation({ currentRelease: input.release, config: input.config,
    receipt: active, features: { ...disabled, auth: true } }), { code: "ERR_ASSERTION", message: /PRODUCTION_ACTIVATION_REQUIRES_CLOSED_RECEIPT/ });
});
