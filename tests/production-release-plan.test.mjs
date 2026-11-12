import assert from "node:assert/strict";
import test from "node:test";
import { sha256, TARGETS } from "../scripts/release/bundle.mjs";
import { applySyntheticRelease } from "../scripts/release/deploy.mjs";
import { planProductionBootstrap, planProductionChange, planProductionActivation,
  planProductionPrivatePreview, planProductionPreviewClose, executeProductionPlan } from "../scripts/release/production-plan.mjs";

const sourceSha = "a".repeat(40), previousSha = "b".repeat(40), digest = "c".repeat(64);
const disabled = { auth: false, media: false, publishing: false, comments: false };
function fixture() {
  const config = { version: 1, deploymentId: "a1234567-1234-4234-8234-123456789abc", environment: "production",
    database: { host: "postgres", port: 5432, name: "mq_production" }, origin: "https://synthetic.example.invalid",
    media: { root: "/var/lib/mq/media", minFreeBytes: 8 * 1024 ** 3 } };
  const release = { version: 1, sourceSha, platform: "linux/amd64", gate: { kind: "reviewed-main", sourceSha },
    compatibility: { migrations: Array.from({ length: 9 }, (_, index) => ({ name: `migration_00${index + 1}`, sha256: digest })),
      contracts: { schema: digest, permissions: digest,
        "scripts/release/production-plan.mjs": digest, "scripts/release/production-host.mjs": digest } },
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

test("all four image digests, nine migrations and reviewed candidate identity are required", () => {
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

test("upgrade and rollback retain data compatibility and fresh-backup requirements", () => {
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

test("production upgrade from 009 binds reviewed 010 and runs migration; rollback cannot remove it", async () => {
  const input = fixture();
  input.release.compatibility.migrations.push({ name: "202611120010_seven_story_stars", sha256: digest });
  const plan = planProductionChange({ ...input, mode: "upgrade" }), calls = [];
  const result = await executeProductionPlan({ plan, ...permission(plan), execute: executor(calls) });
  assert.ok(calls.includes("migrate") && calls.includes("provision"));
  assert.equal(result.receipt.release.compatibility.migrations.length, 10);
  assert.equal(plan.currentRelease.compatibility.migrations.length, 9);
  assert.equal(planProductionBootstrap(input).release.compatibility.migrations.length, 10);
  assert.throws(() => planProductionChange({ ...input, release: input.currentRelease,
    currentRelease: input.release, mode: "rollback" }), /INCOMPATIBLE/);
  input.release.compatibility.migrations[8].sha256 = "e".repeat(64);
  assert.throws(() => planProductionChange({ ...input, mode: "upgrade" }), /INCOMPATIBLE/);
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

function previewFixture() {
  const input = fixture(), prior = receipt(planProductionBootstrap(input));
  const preview = { version: 1, host: "127.0.0.1", port: 18443,
    ca: { path: "/root/mq-preview/ca.pem", sha256: "1".repeat(64) },
    certificate: { path: "/root/mq-preview/server.pem", sha256: "2".repeat(64) },
    privateKey: { path: "/root/mq-preview/server.key", sha256: "3".repeat(64) } };
  return { currentRelease: input.release, config: input.config, receipt: prior, preview };
}

test("private preview defaults to auth only and binds loopback and certificate identities to its approval", async () => {
  const input = previewFixture(), plan = planProductionPrivatePreview(input), calls = [];
  assert.deepEqual(plan.features, { ...disabled, auth: true });
  assert.equal(plan.publicIngress, false); assert.equal(plan.privateIngress, true);
  assert.equal(plan.origin, input.config.origin);
  const run = executor(calls);
  const result = await executeProductionPlan({ plan, ...permission(plan), execute: async (step, value) => {
    if (step === "private-https") { calls.push(step); return true; }
    if (step === "receipt") { calls.push(step); return { ...receipt(value), privateIngress: true, preview: value.preview }; }
    return run(step, value);
  } });
  assert.deepEqual(calls, ["preflight", "audit", "app", "health", "open-private-ingress", "private-https", "receipt"]);
  assert.equal(result.receipt.privateIngress, true);
  assert.ok(!calls.includes("open-ingress"));
  for (const change of [value => { value.preview.port++; }, value => { value.preview.ca.sha256 = "4".repeat(64); },
    value => { value.preview.privateKey.path = "/other/server.key"; }]) {
    const changed = globalThis.structuredClone(input); change(changed);
    assert.notEqual(planProductionPrivatePreview(changed).planId, plan.planId);
  }
});

test("private business flags require their own plan approval and matching receipt", async () => {
  const input = previewFixture(), authOnly = planProductionPrivatePreview(input);
  const features = { auth: true, media: true, publishing: true, comments: true };
  const plan = planProductionPrivatePreview({ ...input, features });
  assert.notEqual(plan.planId, authOnly.planId);
  assert.deepEqual(plan.features, features); assert.equal(plan.publicIngress, false);
  const calls = [];
  await assert.rejects(executeProductionPlan({ plan, ...permission(authOnly), execute: executor(calls) }), /APPROVAL_MISMATCH/);
  assert.deepEqual(calls, []);
  await assert.rejects(executeProductionPlan({ plan: { ...authOnly, features }, ...permission(authOnly), execute: executor(calls) }), /PLAN_CHANGED/);
  const run = executor(calls);
  const result = await executeProductionPlan({ plan, ...permission(plan), execute: async (step, value) => {
    if (step === "private-https") return true;
    if (step === "receipt") return { ...receipt(value), privateIngress: true, preview: value.preview };
    return run(step, value);
  } });
  assert.deepEqual(result.receipt.features, features);
  assert.throws(() => planProductionActivation({ ...input, receipt: result.receipt, features }), /PREVIEW_MUST_CLOSE/);
  await assert.rejects(executeProductionPlan({ plan, ...permission(plan), execute: async (step, value) => {
    if (step === "private-https") return true;
    if (step === "receipt") return { ...receipt(value), features: authOnly.features, privateIngress: true, preview: value.preview };
    return run(step, value);
  } }), /INGRESS_CLOSED/);
});

test("preview rejects public addresses, extra controls and invalid business features", () => {
  for (const mutate of [
    value => { value.preview.host = "0.0.0.0"; }, value => { value.preview.host = "::"; },
    value => { value.preview.port = 443; }, value => { value.preview.port = 65536; },
    value => { value.preview.certificate.path = "/root/mq/../elsewhere"; },
    value => { value.preview.privateKey.path = value.preview.certificate.path; },
    value => { value.preview.ca.sha256 = "unverified"; },
    value => { value.preview.ca.skipTlsVerification = true; },
    value => { value.features = { ...disabled, auth: true, media: "true" }; },
    value => { value.features = { ...disabled, auth: true, extra: true }; },
    value => { value.features = { auth: true }; },
    value => { value.features = disabled; },
    value => { value.receipt.action = "activate"; value.receipt.publicIngress = true; },
  ]) { const input = previewFixture(); mutate(input); assert.throws(() => planProductionPrivatePreview(input)); }
});

test("private ingress cannot borrow bootstrap approval, expired approval or a public activation", async () => {
  const input = previewFixture(), plan = planProductionPrivatePreview(input), calls = [];
  const bootstrap = planProductionBootstrap({ release: input.currentRelease, config: input.config,
    candidateManifestSha256: input.receipt.candidateManifestSha256 });
  await assert.rejects(executeProductionPlan({ plan, ...permission(bootstrap), execute: executor(calls) }), /APPROVAL_MISMATCH/);
  const old = permission(plan); old.approval.expiresAt = new Date(old.now - 1).toISOString();
  await assert.rejects(executeProductionPlan({ plan, ...old, execute: executor(calls) }), /APPROVAL_EXPIRED/);
  const previewReceipt = { ...receipt(plan), privateIngress: true, preview: plan.preview };
  assert.throws(() => planProductionActivation({ ...input, receipt: previewReceipt }), /PREVIEW_MUST_CLOSE/);
  assert.throws(() => planProductionPrivatePreview({ ...input, receipt: previewReceipt }), /PREVIEW_MUST_CLOSE/);
  assert.deepEqual(calls, []);
});

test("ending preview closes first, drains writers, revokes sessions and restores disabled features before a closed receipt", async () => {
  const input = previewFixture(), start = planProductionPrivatePreview({ ...input,
    features: { auth: true, media: true, publishing: true, comments: true } });
  const plan = planProductionPreviewClose({ ...input, receipt: { ...receipt(start), privateIngress: true, preview: start.preview } });
  const calls = [], run = executor(calls);
  const result = await executeProductionPlan({ plan, ...permission(plan), execute: async (step, value) => {
    if (step === "receipt") { calls.push(step); return { ...receipt(value), privateIngress: false, previewSessionsRevoked: true }; }
    return run(step, value);
  } });
  assert.deepEqual(calls, ["preflight", "close-ingress", "stop-app", "pause-preview-writers", "revoke-preview-sessions",
    "resume-preview-writers", "audit", "app", "health", "receipt"]);
  assert.deepEqual(result.receipt.features, disabled);
  const publicPlan = planProductionActivation({ ...input, receipt: result.receipt });
  await assert.rejects(executeProductionPlan({ plan: publicPlan, ...permission(plan), execute: executor([]) }), /APPROVAL_MISMATCH/);
  assert.notEqual(publicPlan.planId, plan.planId);
});

test("private TLS or session-revocation failure never returns a successful closed or preview receipt", async () => {
  const input = previewFixture(), start = planProductionPrivatePreview(input);
  const close = planProductionPreviewClose({ ...input, receipt: { ...receipt(start), privateIngress: true, preview: start.preview } });
  for (const [plan, fail] of [[start, "private-https"], [close, "revoke-preview-sessions"]]) {
    const calls = [];
    await assert.rejects(executeProductionPlan({ plan, ...permission(plan), execute: executor(calls, { [fail]: false }) }), /INGRESS_CLOSED/);
    assert.deepEqual(calls.slice(-2), ["close-ingress", "stop-app"]);
    assert.ok(!calls.includes("receipt"));
    if (plan === close) assert.ok(!calls.includes("resume-preview-writers"));
  }
});
