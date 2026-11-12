import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { verifyReleaseGate } from "../scripts/release/gate.mjs";
import { inspectOciArchive, sha256, TARGETS } from "../scripts/release/bundle.mjs";
import { planRelease, applySyntheticRelease } from "../scripts/release/deploy.mjs";
import { releaseProbeFailure } from "../scripts/release/integration.mjs";
import { runReleaseCommand } from "../scripts/release/cli.mjs";

test("release probe diagnostics distinguish required storage without printing arbitrary errors or private paths", () => {
  const storage = Object.assign(new Error("RELEASE_CONTAINERD_REQUIRED"), { releaseProbeStage: "docker-info" });
  assert.deepEqual(releaseProbeFailure(storage), { code: "RELEASE_CONTAINERD_REQUIRED", stage: "docker-info" });
  const child = Object.assign(new Error("RELEASE_CONTAINER_COMMAND_FAILED: arbitrary-private-value"), { releaseProbeStage: "oci-load" });
  assert.deepEqual(releaseProbeFailure(child), { code: "RELEASE_CONTAINER_COMMAND_FAILED", stage: "oci-load" });
  const privateError = Object.assign(new Error("secret=synthetic-credential /private/path"), { releaseProbeStage: "secret-private-path" });
  assert.deepEqual(releaseProbeFailure(privateError), { code: "RELEASE_CONTAINER_PROBE_FAILED", stage: "unknown" });
});

const sourceSha = "a".repeat(40), otherSha = "b".repeat(40);
function githubFixture(change = {}) {
  const pr = { number: 55, user: { login: "SynapseOperator" }, head: { sha: otherSha }, base: { ref: "main" },
    merged: true, merged_at: "2026-11-01T00:00:00Z", merge_commit_sha: sourceSha };
  const values = { main: { object: { sha: "c".repeat(40) } },
    comparison: { status: "ahead", merge_base_commit: { sha: sourceSha } }, pulls: [pr], pr,
    reviews: [{ id: 1, user: { login: "SnorkelingBreather" }, state: "APPROVED", commit_id: otherSha }],
    unresolved: false, runs: { workflow_runs: [{ id: 99, head_sha: sourceSha, head_branch: "main", status: "completed", conclusion: "success" }] },
    jobs: ["quality", "database", "container"].map(name => ({ name, status: "completed", conclusion: "success" })), ...change };
  return async path => {
    if (path.endsWith("/heads/main")) return values.main;
    if (path.includes("/compare/")) return values.comparison;
    if (path.includes("/commits/")) return values.pulls;
    if (path.includes("/reviews?")) return values.reviews;
    if (path === "reviewThreads") return values.unresolved;
    if (path.includes("/workflows/")) return values.runs;
    if (path.includes("/jobs?")) return values.jobs;
    return values.pr;
  };
}

test("release gate accepts a reviewed main ancestor with all three current CI jobs", async () => {
  const result = await verifyReleaseGate({ sourceSha, request: githubFixture() });
  assert.equal(result.sourceSha, sourceSha); assert.equal(result.reviewedHead, otherSha);
  assert.equal(result.qualityRunId, 99);
  assert.equal(result.ciExemption, undefined);
});

const ciExemption = { version: 1, sourceSha, reason: "owner-approved-github-actions-quota", localValidationSha256: "d".repeat(64) };
const failedCi = { runs: { workflow_runs: [{ id: 100, head_sha: sourceSha, head_branch: "main", status: "completed", conclusion: "failure" }] },
  jobs: ["quality", "database", "container"].map(name => ({ name, status: "completed", conclusion: name === "quality" ? "failure" : "skipped" })) };
test("explicit owner CI exemption preserves failed or missing CI evidence instead of claiming success", async () => {
  await assert.rejects(verifyReleaseGate({ sourceSha, request: githubFixture(failedCi) }), /MAIN_CI_REQUIRED/);
  const result = await verifyReleaseGate({ sourceSha, request: githubFixture(failedCi), ownerCiExemption: ciExemption });
  assert.equal(result.qualityRunId, null);
  assert.deepEqual(result.ciExemption, ciExemption);
  assert.deepEqual(result.observedCi, { runId: 100, status: "completed", conclusion: "failure", jobs: failedCi.jobs });
  const missing = await verifyReleaseGate({ sourceSha, request: githubFixture({ runs: { workflow_runs: [] } }), ownerCiExemption: ciExemption });
  assert.deepEqual(missing.observedCi, { runId: null, status: "missing", conclusion: null, jobs: [] });
});
test("CI exemption cannot waive main ancestry, exact independent Review or unresolved threads", async () => {
  for (const change of [
    { comparison: { status: "diverged", merge_base_commit: { sha: otherSha } } },
    { reviews: [{ id: 1, user: { login: "SnorkelingBreather" }, state: "APPROVED", commit_id: sourceSha }] },
    { reviews: [{ id: 1, user: { login: "SnorkelingBreather" }, state: "APPROVED", commit_id: otherSha },
      { id: 2, user: { login: "SnorkelingBreather" }, state: "CHANGES_REQUESTED", commit_id: otherSha }] },
    { unresolved: true },
  ]) await assert.rejects(verifyReleaseGate({ sourceSha, request: githubFixture({ ...failedCi, ...change }), ownerCiExemption: ciExemption }));
  for (const value of [{ ...ciExemption, sourceSha: otherSha }, { ...ciExemption, reason: "skip-review" },
    { ...ciExemption, localValidationSha256: "unverified" }, { ...ciExemption, skipReview: true }, null]) {
    await assert.rejects(verifyReleaseGate({ sourceSha, request() { assert.fail("Bad exemption rejected before GitHub access"); }, ownerCiExemption: value }), /CI_EXEMPTION/);
  }
});
test("CLI needs the explicit CI exemption file option; environment flags cannot silently bypass CI", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mq-ci-exemption-"));
  t.after(() => rm(directory, { recursive: true }));
  const file = join(directory, "owner-exemption.json"), target = join(directory, "gate.json");
  await writeFile(file, JSON.stringify(ciExemption));
  const request = githubFixture(failedCi);
  t.mock.method(globalThis, "fetch", async url => {
    const parsed = new URL(url), path = `${parsed.pathname}${parsed.search}`;
    const value = parsed.pathname === "/graphql"
      ? { data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }
      : path.includes("/jobs?") ? { jobs: await request(path) } : await request(path);
    return { ok: true, json: async () => value };
  });
  t.mock.method(console, "log", () => {}); t.mock.method(console, "error", () => {});
  assert.equal(await runReleaseCommand(["gate", sourceSha, target], { GH_TOKEN: "synthetic-only", OWNER_CI_EXEMPTION: file }), 1);
  await assert.rejects(readFile(target), { code: "ENOENT" });
  assert.equal(await runReleaseCommand(["gate", sourceSha, target, "--owner-ci-exemption", file], { GH_TOKEN: "synthetic-only" }), 0);
  const saved = JSON.parse(await readFile(target, "utf8"));
  assert.equal(saved.observedCi.conclusion, "failure"); assert.deepEqual(saved.ciExemption, ciExemption);
  assert.equal(await runReleaseCommand(["gate", sourceSha, target, "--owner-ci-exemption", file], { GH_TOKEN: "synthetic-only" }), 1,
    "Existing gate evidence is never overwritten");
});
test("approval strings, old-head approval, later change requests and unresolved threads cannot release", async () => {
  for (const change of [
    { comparison: { status: "diverged", merge_base_commit: { sha: otherSha } } },
    { reviews: [{ id: 1, user: { login: "SnorkelingBreather" }, state: "APPROVED", commit_id: sourceSha }] },
    { reviews: [{ id: 1, user: { login: "SnorkelingBreather" }, state: "APPROVED", commit_id: otherSha },
      { id: 2, user: { login: "SnorkelingBreather" }, state: "CHANGES_REQUESTED", commit_id: otherSha }] },
    { reviews: [{ id: 1, user: { login: "SnorkelingBreather" }, state: "APPROVED", commit_id: otherSha },
      { id: 2, user: { login: "AnotherReviewer" }, state: "CHANGES_REQUESTED", commit_id: otherSha }] },
    { unresolved: true }, { jobs: [] }, { jobs: ["quality", "database", "container"].map(name => ({ name, status: "completed", conclusion: name === "database" ? "skipped" : "success" })) },
    { runs: { workflow_runs: [{ id: 99, head_sha: sourceSha, head_branch: "main", status: "completed", conclusion: "success" },
      { id: 100, head_sha: sourceSha, head_branch: "main", status: "in_progress", conclusion: null }] } },
  ]) await assert.rejects(verifyReleaseGate({ sourceSha, request: githubFixture(change) }));
});

// Small USTAR fixture: tests a documented archive boundary, not a mock Docker
// success. The separate integration test loads and executes a real OCI image.
function tar(entries) {
  const chunks = [];
  for (const [name, bytes, type = "0"] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.fill(32, 148, 156); header.write(type, 156); header.write("ustar\0", 257); header.write("00", 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function archiveEntries({ architecture = "amd64", user = "10001:10001", omitLayer = false } = {}) {
  const entries = [], blob = (value, mediaType) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const digest = `sha256:${sha256(bytes)}`; entries.push([`blobs/sha256/${digest.slice(7)}`, bytes]);
    return { mediaType, digest, size: bytes.length };
  };
  const layer = blob(Buffer.from("synthetic layer bytes"), "application/vnd.oci.image.layer.v1.tar");
  const config = blob({ os: "linux", architecture, config: { User: user, Labels: { "org.opencontainers.image.revision": sourceSha } } }, "application/vnd.oci.image.config.v1+json");
  const manifest = blob({ schemaVersion: 2, config, layers: [layer] }, "application/vnd.oci.image.manifest.v1+json");
  entries.push(["oci-layout", Buffer.from('{"imageLayoutVersion":"1.0.0"}')],
    ["index.json", Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [manifest] }))]);
  return omitLayer ? entries.slice(1) : entries;
}
test("OCI integrity reads real bytes, distinguishes manifest/config/archive hashes and rejects corrupt blobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-release-unit-"));
  try {
    const path = join(directory, "image.tar"), entries = archiveEntries();
    await writeFile(path, tar(entries));
    const result = await inspectOciArchive(path, { sourceSha });
    assert.notEqual(result.manifestDigest, result.configDigest);
    assert.notEqual(result.archiveSha256, result.manifestDigest.slice(7));
    entries[0][1][0] ^= 1;
    await writeFile(path, tar(entries));
    await assert.rejects(inspectOciArchive(path), /RELEASE_BLOB_DIGEST_REJECTED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("missing layers, foreign platform, root user, links, duplicate and traversal paths are rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-release-unit-")), path = join(directory, "image.tar");
  try {
    for (const entries of [archiveEntries({ omitLayer: true }), archiveEntries({ architecture: "arm64" }), archiveEntries({ user: "0" }),
      [...archiveEntries(), ["../escape", Buffer.alloc(0)]], [...archiveEntries(), ["oci-layout", Buffer.alloc(0)]],
      [...archiveEntries(), ["blobs/sha256/" + "c".repeat(64), Buffer.alloc(0), "2"]]]) {
      await writeFile(path, tar(entries)); await assert.rejects(inspectOciArchive(path));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function deploymentFixture() {
  const deploymentId = "a1234567-1234-4234-8234-123456789abc";
  const release = { version: 1, sourceSha, platform: "linux/amd64",
    compatibility: { migrations: Array.from({ length: 9 }, (_, index) => ({ name: String(index), sha256: "f".repeat(64) })),
      contracts: { schema: "test", "scripts/release/production-plan.mjs": "f".repeat(64),
        "scripts/release/production-host.mjs": "f".repeat(64) } },
    images: Object.fromEntries(TARGETS.map(target => [target, { indexDigest: `sha256:${"f".repeat(64)}` }])) };
  return { release, currentRelease: globalThis.structuredClone(release), config: { version: 1, deploymentId, environment: "staging",
    database: { host: "postgres", port: 5432, name: `mq_staging_${deploymentId.replaceAll("-", "")}` }, origin: "https://synthetic.localhost" },
    backupReceipt: { verified: true, deploymentId, snapshotId: "a".repeat(64), completedAt: new Date().toISOString() } };
}
test("default deployment is a side-effect-free plan with migration/permission/secret compatibility gates", () => {
  const fixture = deploymentFixture(), plan = planRelease(fixture);
  assert.equal(plan.productionApplyAllowed, false); assert.equal(plan.restoreOldSecrets, false);
  fixture.release.compatibility.contracts.schema = "changed";
  assert.throws(() => planRelease(fixture), /INCOMPATIBLE/);
});
test("upgrade permits only reviewed executor changes; rollback and every data/runtime contract stay exact", () => {
  for (const name of ["scripts/release/production-plan.mjs", "scripts/release/production-host.mjs"]) {
    const fixture = deploymentFixture();
    fixture.release.compatibility.contracts[name] = "e".repeat(64);
    assert.equal(planRelease(fixture).mode, "upgrade");
    assert.equal(fixture.release.compatibility.contracts[name], "e".repeat(64), "Planning does not rewrite candidate evidence");
    assert.throws(() => planRelease({ ...fixture, mode: "rollback" }), /INCOMPATIBLE/);
    for (const target of ["release", "currentRelease"]) {
      const missing = globalThis.structuredClone(fixture); delete missing[target].compatibility.contracts[name];
      assert.throws(() => planRelease(missing), /EXECUTOR_CONTRACT_REQUIRED/);
      const malformed = globalThis.structuredClone(fixture); malformed[target].compatibility.contracts[name] = "unverified";
      assert.throws(() => planRelease(malformed), /EXECUTOR_CONTRACT_REQUIRED/);
    }
  }
  for (const name of ["prisma/schema.prisma", "scripts/production/database-policy.mjs", "scripts/production/runtime-config.mjs",
    "compose.production.yaml", "src/server/auth/session-storage.ts", "src/server/auth/session-adapter.ts",
    "ops/Caddyfile.private", "scripts/production/caddy-entrypoint.sh", "unknown-future-contract"]) {
    const fixture = deploymentFixture();
    fixture.currentRelease.compatibility.contracts[name] = "f".repeat(64);
    fixture.release.compatibility.contracts[name] = "e".repeat(64);
    assert.throws(() => planRelease(fixture), /INCOMPATIBLE/);
    delete fixture.release.compatibility.contracts[name];
    assert.throws(() => planRelease(fixture), /INCOMPATIBLE/);
  }
  const migration = deploymentFixture(); migration.release.compatibility.migrations[8].sha256 = "e".repeat(64);
  assert.throws(() => planRelease(migration), /INCOMPATIBLE/);
});
test("wrong/stale backup and production apply reject before executing anything", async () => {
  const fixture = deploymentFixture();
  assert.throws(() => planRelease({ ...fixture, backupReceipt: { ...fixture.backupReceipt, deploymentId: "wrong" } }));
  assert.throws(() => planRelease({ ...fixture, backupReceipt: { ...fixture.backupReceipt, completedAt: "2020-01-01" } }));
  const plan = planRelease({ ...fixture, config: { ...fixture.config, environment: "production", database: { ...fixture.config.database, name: "mq_production" } } });
  await assert.rejects(applySyntheticRelease({ plan, confirmation: plan.deploymentId, execute() { assert.fail("must not execute"); } }), /NOT_AUTHORIZED/);
});
test("failed health never reopens ingress; compatible application rollback does not migrate or restore secrets", async () => {
  const plan = planRelease(deploymentFixture()), calls = [];
  await assert.rejects(applySyntheticRelease({ plan, confirmation: plan.deploymentId,
    execute: async step => { calls.push(step); return step === "health" ? false : undefined; } }), /INGRESS_CLOSED/);
  assert.ok(!calls.includes("open-ingress")); assert.deepEqual(calls.slice(-2), ["close-ingress", "stop-app"]);
  const rollback = planRelease({ ...deploymentFixture(), mode: "rollback" }), applied = [];
  const result = await applySyntheticRelease({ plan: rollback, confirmation: rollback.deploymentId,
    execute: async step => { applied.push(step); if (step === "health") return true; } });
  assert.equal(result.productionDeployed, false); assert.ok(!applied.includes("migrate"));
  assert.deepEqual(applied, rollback.steps);
});
test("changed plan, wrong target and unconfirmed containment cannot report a successful release", async () => {
  const plan = planRelease(deploymentFixture());
  await assert.rejects(applySyntheticRelease({ plan: { ...plan, sourceSha: otherSha }, confirmation: plan.deploymentId, execute() {} }), /PLAN_CHANGED/);
  await assert.rejects(applySyntheticRelease({ plan, confirmation: "wrong", execute() {} }), /CONFIRMATION_REQUIRED/);
  await assert.rejects(applySyntheticRelease({ plan, confirmation: plan.deploymentId, execute() { throw new Error("synthetic docker failure"); } }), /CONTAINMENT_UNCONFIRMED/);
});
