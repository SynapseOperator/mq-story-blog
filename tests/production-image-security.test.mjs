import assert from "node:assert/strict";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { scanImages, summarizeImageScan } from "../scripts/production/image-security-scan.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const report = vulnerabilities => ({ Metadata: { ImageID: digest },
  Results: [{ Target: "test", Vulnerabilities: vulnerabilities }] });

test("scan preserves unfixed Critical, fixed High and every other severity", () => {
  const result = summarizeImageScan(report([
    { Severity: "CRITICAL", VulnerabilityID: "CVE-critical", PkgName: "package-a" },
    { Severity: "HIGH", VulnerabilityID: "CVE-high", PkgName: "package-b", FixedVersion: "2" },
    ...["MEDIUM", "LOW", "UNKNOWN"].map(Severity => ({ Severity })),
  ]), digest, 1);
  assert.deepEqual(result.counts, { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1, UNKNOWN: 1 });
  assert.equal(result.fixableHighCritical, 1);
  assert.equal(result.highCritical.length, 2);
  assert.equal(result.highCritical[0].fixed, null);
  assert.equal(result.exitCode, 1);
});

test("scan cannot use another image's report or label failed/incomplete scans successful", () => {
  assert.throws(() => summarizeImageScan(report([]), `sha256:${"b".repeat(64)}`, 0), /PROVENANCE/);
  assert.throws(() => summarizeImageScan({ Metadata: { ImageID: digest } }, digest, 0), /RESULTS/);
  assert.throws(() => summarizeImageScan(report([]), digest, 2), /TOOL_FAILED/);
  assert.throws(() => summarizeImageScan(report([{ Severity: "HIGH" }]), digest, 0), /EXIT_RESULT/);
  assert.throws(() => summarizeImageScan(report([]), digest, 1), /EXIT_RESULT/);
  assert.equal(summarizeImageScan(report([]), digest, 0).exitCode, 0);
});

test("scan refuses repository output including a misleading dot-dot name", async () => {
  for (const name of ["../evidence", "../..evidence"]) {
    await assert.rejects(scanImages({ directory: fileURLToPath(new URL(name, import.meta.url)) }),
      /SCAN_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY/);
  }
});
