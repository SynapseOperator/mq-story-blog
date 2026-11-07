import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runVpsBrowserChecks, validateVpsFixture } from "../scripts/production/vps-browser-checks.mjs";

function fixture() {
  return { version: 1, synthetic: true, origin: "https://mq.localhost:18443",
    ca: "-----BEGIN CERTIFICATE-----\nsynthetic-fixture-only\n-----END CERTIFICATE-----\n",
    accounts: { admin: { username: "lab_admin_1234abcd", password: "SyntheticAdminPasswordForFixtureOnly" },
      reader: { username: "lab_reader_1234abcd", password: "SyntheticReaderPasswordForFixtureOnly" } } };
}

test("VPS browser fixture is limited to a synthetic loopback TLS tunnel", () => {
  assert.equal(validateVpsFixture(fixture()).origin, "https://mq.localhost:18443");
  for (const origin of ["https://mq-story.xyz:18443", "http://mq.localhost:18443", "https://mq.localhost",
    "https://name:password@mq.localhost:18443", "https://mq.localhost:18443/?token=private", "https://mq.localhost:18443/#private"]) {
    assert.throws(() => validateVpsFixture({ ...fixture(), origin }));
  }
  assert.throws(() => validateVpsFixture({ ...fixture(), synthetic: false }));
});

test("VPS browser fixture does not accept real account names or reused synthetic passwords", () => {
  const value = fixture(); value.accounts.admin.username = "real-admin";
  assert.throws(() => validateVpsFixture(value));
  value.accounts.admin.username = "lab_admin_1234abcd";
  value.accounts.admin.password = value.accounts.reader.password;
  assert.throws(() => validateVpsFixture(value));
});

test("unsupported phase fails before reading credentials or making requests", async () => {
  await assert.rejects(runVpsBrowserChecks({ phase: "production", fixturePath: "absent",
    statePath: "absent", evidenceDirectory: "absent" }), /VPS_CHECK_PHASE_REJECTED/);
});

test("invalid target leaves an existing checkpoint unchanged and does not start a network test", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-vps-browser-test-"));
  try {
    const fixturePath = join(directory, "fixture.json"), statePath = join(directory, "state.json");
    await writeFile(fixturePath, JSON.stringify({ ...fixture(), origin: "https://mq-story.xyz" }), { mode: 0o600 });
    await writeFile(statePath, "original checkpoint", { mode: 0o600 });
    await assert.rejects(runVpsBrowserChecks({ phase: "before", fixturePath, statePath, evidenceDirectory: directory }));
    assert.equal(await readFile(statePath, "utf8"), "original checkpoint");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("browser-only resume refuses an incomplete business checkpoint without writing or requesting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-vps-browser-resume-test-"));
  try {
    const fixturePath = join(directory, "fixture.json"), statePath = join(directory, "state.json");
    const original = JSON.stringify({ version: 1, synthetic: true, origin: fixture().origin, beforePassed: false });
    await writeFile(fixturePath, JSON.stringify(fixture()), { mode: 0o600 });
    await writeFile(statePath, original, { mode: 0o600 });
    await assert.rejects(runVpsBrowserChecks({ phase: "resume-browser", fixturePath, statePath,
      evidenceDirectory: directory }), /VPS_BUSINESS_CHECKPOINT_REQUIRED/);
    assert.equal(await readFile(statePath, "utf8"), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
