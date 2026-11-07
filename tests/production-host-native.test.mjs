import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import { parseNativeHostPreflight } from "../scripts/production/host-preflight-import.mjs";

const GiB = 1024 ** 3;
const collector = fileURLToPath(new URL("../scripts/production/host-preflight-native.sh", import.meta.url));
const importer = fileURLToPath(new URL("../scripts/production/host-preflight-import.mjs", import.meta.url));
function fixture(changes = {}, listeners = ["tcp,22,non-loopback"]) {
  const fields = { version: "1", checkedAt: "2026-11-06T12:00:00Z", privilegedRequested: "no", platform: "linux", osId: "ubuntu", osVersion: "24.04", architecture: "x86_64",
    cpuCount: 4, totalMemoryBytes: 4 * GiB, freeMemoryBytes: 3 * GiB, swapTotalBytes: GiB, swapFreeBytes: GiB,
    load1: "0.15", load5: "0.1", load15: "0.05", diskBytes: 40 * GiB, freeDiskBytes: 32 * GiB, inodeCount: 10000, freeInodeCount: 9000,
    timezone: "Etc/UTC", timeSynchronized: "true", apparmorEnabled: "true", apparmorService: "active", sshService: "inactive", sshSocket: "active", sshSocketEnabled: "enabled", ufwActive: "true",
    sshConnectionContext: "true", sshHostMatchVerified: "true", dockerVersion: "29.0.0", composeVersion: "v2.40.0", nodeMajor: 24,
    ipv4Configured: "true", ipv6Configured: "true", ipv6GlobalConfigured: "false", listenersKnown: "true" };
  for (const context of ["default", "connection", "root"]) Object.assign(fields, {
    [`ssh.${context}.permitRootLogin`]: "no", [`ssh.${context}.passwordAuthentication`]: "false",
    [`ssh.${context}.keyboardInteractiveAuthentication`]: "false", [`ssh.${context}.publicKeyAuthentication`]: "true" });
  Object.assign(fields, changes);
  return [...Object.entries(fields).map(([key, value]) => `${key}\t${value}`), ...listeners.map(value => `listener\t${value}`)].join("\n") + "\n";
}
const status = (report, code) => report.checks.find(item => item.code === code)?.status;

test("native import reuses existing thresholds, separates resource readiness and preserves socket activation evidence", () => {
  const report = parseNativeHostPreflight(fixture());
  assert.equal(report.check, "mq-host-native");
  assert.equal(report.status, "pass");
  assert.equal(report.hardware.status, "pass");
  assert.equal(report.sample.architecture, "x64");
  assert.equal(report.sample.inodeFreePercent, 90);
  assert.deepEqual(report.native.load, [0.15, 0.1, 0.05]);
  assert.equal(report.native.services.sshService, "inactive");
  assert.equal(report.native.services.sshSocket, "active");
  assert.equal(report.sample.network.ipv6GlobalConfigured, false);
  assert.ok(report.unverified.includes("CLOUD_FIREWALL"));
  assert.ok(report.unverified.includes("EXTERNAL_IPV4_IPV6_PORTS"));
});

test("no remote Node is needed to collect, but absent Node remains an existing deployment blocker", () => {
  const report = parseNativeHostPreflight(fixture({ nodeMajor: "unknown", dockerVersion: "unknown", composeVersion: "unknown" }));
  assert.equal(report.hardware.status, "pass");
  assert.equal(report.status, "block");
  assert.equal(status(report, "NODE_24_REQUIRED"), "block");
  assert.equal(status(report, "DOCKER_LOCAL_ENGINE"), "warn");
  assert.equal(status(report, "COMPOSE_V2"), "warn");
});

test("insufficient resources and publicly bound private ports keep their blocking thresholds", () => {
  for (const [changes, code] of [[{ totalMemoryBytes: 2 * GiB }, "MEMORY_CAPACITY"], [{ freeMemoryBytes: 128 * 1024 ** 2 }, "MEMORY_AVAILABLE"], [{ freeDiskBytes: 7 * GiB }, "DISK_RESERVE"], [{ freeInodeCount: 499 }, "INODE_RESERVE"]]) {
    assert.equal(status(parseNativeHostPreflight(fixture(changes)), code), "block");
  }
  assert.equal(status(parseNativeHostPreflight(fixture({}, ["tcp,5432,non-loopback"])), "PRIVATE_PORTS_NOT_EXPOSED"), "block");
  assert.equal(status(parseNativeHostPreflight(fixture({}, ["tcp,5432,loopback"])), "PRIVATE_PORTS_NOT_EXPOSED"), "pass");
  assert.equal(status(parseNativeHostPreflight(fixture({ listenersKnown: "unknown" }, [])), "LISTENERS_UNVERIFIED"), "block");
});

test("default sshd values cannot substitute for the actual connection or root Match context", () => {
  const report = parseNativeHostPreflight(fixture({ "ssh.connection.passwordAuthentication": "true", "ssh.root.permitRootLogin": "yes" }));
  assert.equal(report.native.ssh.defaults.passwordAuthentication, false);
  assert.equal(status(report, "SSH_PASSWORD_LOGIN_DISABLED"), "block");
  assert.equal(status(report, "SSH_ROOT_MATCH_LOGIN_DISABLED"), "block");
  const unknown = parseNativeHostPreflight(fixture({ "ssh.connection.passwordAuthentication": "unknown", sshConnectionContext: "false", sshHostMatchVerified: "unknown", ufwActive: "unknown" }));
  assert.equal(status(unknown, "SSH_PASSWORD_LOGIN_DISABLED"), "warn");
  assert.equal(status(unknown, "SSH_CURRENT_CONNECTION_MATCH"), "warn");
  assert.equal(status(unknown, "UFW_STATUS"), "warn");
});

test("import boundary rejects banners, extra or duplicate fields, addresses, invalid values and excess output without echoing them", () => {
  const valid = fixture();
  const invalid = ["", valid + "Welcome to host.example\n", valid + "SSH_CONNECTION\t192.0.2.1\n", valid + "osId\tubuntu\n",
    fixture({ dockerVersion: "password-secret" }), fixture({ nodeMajor: "24\tsecret" }), fixture({ totalMemoryBytes: "1e12" }), fixture({ load1: "NaN" }),
    fixture({ "ssh.root.permitRootLogin": "perhaps" }), fixture({ timeSynchronized: "yes" }), fixture({ timezone: "../../secret" }),
    fixture({}, ["tcp,65536,non-loopback"]), fixture({}, ["tcp,22,192.0.2.1"]), fixture({}, ["tcp,22,loopback", "tcp,22,loopback"]),
    fixture({ listenersKnown: "unknown" }), valid.replace(/^checkedAt.*\n/m, ""), "x".repeat(65537)];
  for (const input of invalid) assert.throws(() => parseNativeHostPreflight(input), { message: "NATIVE_HOST_REPORT_REJECTED" });
});

test("local CLI emits only validated JSON and returns a blocking exit without echoing raw errors", () => {
  const good = execFileSync(process.execPath, [importer], { input: fixture(), encoding: "utf8" });
  assert.equal(JSON.parse(good).status, "pass");
  assert.throws(() => execFileSync(process.execPath, [importer], { input: fixture({ nodeMajor: "unknown" }), stdio: ["pipe", "pipe", "pipe"] }), error => {
    assert.equal(error.status, 1);
    assert.equal(JSON.parse(error.stdout).hardware.status, "pass");
    return true;
  });
  assert.throws(() => execFileSync(process.execPath, [importer], { input: "private-token-and-host\n", stdio: ["pipe", "pipe", "pipe"] }), error => {
    assert.equal(error.stdout.length, 0);
    assert.equal(error.stderr.toString().trim(), "MQ_NATIVE_HOST_IMPORT_FAILED");
    return true;
  });
});

test("native shell remains stdin compatible with fixed noninteractive readonly commands", () => {
  const script = readFileSync(collector, "utf8");
  assert.ok(!script.includes("\r"), "SSH stdin must use LF");
  assert.match(script, /timeout 6 "\$@" 2>\/dev\/null/);
  assert.match(script, /sudo -n --/);
  assert.match(script, /sshd -T -C "user=root,/);
  assert.ok(!script.includes("node -e"));
  assert.ok(!script.includes("apt "));
});

test("Linux executes the native collector without installation, writes or privilege escalation", { skip: process.platform !== "linux" }, () => {
  execFileSync("sh", ["-n", collector], { timeout: 10000 });
  const raw = execFileSync("sh", [collector], { encoding: "utf8", timeout: 180000, maxBuffer: 65536 });
  const report = parseNativeHostPreflight(raw);
  assert.equal(report.native.privilegedRequested, false);
  assert.equal(report.sample.platform, "linux");
  assert.ok(!raw.includes("SSH_CONNECTION"));
  assert.ok(!raw.includes("/home/"));
  assert.ok(!raw.includes("Permission denied"));
  assert.throws(() => execFileSync("sh", [collector, "--unexpected"], { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] }), error => error.status === 1 && error.stderr.toString().trim() === "NATIVE_PREFLIGHT_ARGUMENT_REJECTED");
});
