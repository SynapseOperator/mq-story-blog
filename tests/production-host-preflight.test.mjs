import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { promisify } from "node:util";
import { assessHostPreflight, collectHostPreflight, parseHostListeners, parseHostNetworkPresence, parseHostSecurity } from "../scripts/production/host-preflight.mjs";

const execute = promisify(execFile);
const GiB = 1024 ** 3;
const healthy = () => ({ platform: "linux", osId: "ubuntu", osVersion: "24.04", architecture: "x64", nodeMajor: 24,
  cpuCount: 4, totalMemoryBytes: 4 * GiB, freeMemoryBytes: GiB, diskBytes: 40 * GiB, freeDiskBytes: 20 * GiB,
  swapTotalBytes: GiB, swapFreeBytes: GiB, inodeFreePercent: 60, timeSynchronized: true, timezone: "Asia/Hong_Kong",
  network: { ipv4Configured: true, ipv6Configured: true },
  security: { apparmorEnabled: true, ufwActive: true, ssh: { permitRootLogin: "no", passwordAuthentication: false,
    keyboardInteractiveAuthentication: false, publicKeyAuthentication: true } }, tools: { docker: "29.5.4", compose: "v2.39.1" },
  listeners: [{ protocol: "tcp", port: 22, scope: "non-loopback" }] });

test("supported host resources pass without asserting remote security readiness", () => {
  const result = assessHostPreflight(healthy());
  assert.equal(result.status, "pass");
  assert.ok(result.checks.every(item => item.status === "pass"));
});

test("release architecture, unsupported OS, low resources and unsafe listeners block", () => {
  const sample = { ...healthy(), architecture: "arm64", osVersion: "22.04", totalMemoryBytes: 2 * GiB,
    freeMemoryBytes: 1, freeDiskBytes: 1, inodeFreePercent: 1, timeSynchronized: false,
    listeners: [{ protocol: "tcp", port: 5432, scope: "non-loopback" }] };
  const result = assessHostPreflight(sample);
  assert.equal(result.status, "block");
  assert.deepEqual(result.checks.filter(item => item.status === "block").map(item => item.code), [
    "UBUNTU_24_04_REQUIRED", "RELEASE_ARCH_AMD64_REQUIRED", "MEMORY_CAPACITY", "MEMORY_AVAILABLE", "DISK_RESERVE",
    "INODE_RESERVE", "TIME_SYNCHRONIZED", "PRIVATE_PORTS_NOT_EXPOSED",
  ]);
});

test("uninstalled tools, unavailable time and smaller capacity remain explicit warnings", () => {
  const result = assessHostPreflight({ ...healthy(), cpuCount: 2, totalMemoryBytes: 3.25 * GiB,
    diskBytes: 20 * GiB, timeSynchronized: null, inodeFreePercent: null, tools: { docker: null, compose: null },
    listeners: [{ protocol: "tcp", port: 443, scope: "non-loopback" }, { protocol: "udp", port: 9999, scope: "non-loopback" }] });
  assert.equal(result.status, "warn");
  assert.deepEqual(result.checks.filter(item => item.status === "warn").map(item => item.code), [
    "CPU_CAPACITY", "MEMORY_CAPACITY", "DISK_CAPACITY", "INODE_RESERVE", "TIME_SYNCHRONIZED", "DOCKER_LOCAL_ENGINE",
    "COMPOSE_V2", "INGRESS_PORTS_AVAILABLE", "OTHER_LISTENERS_REVIEW",
  ]);
  assert.equal(assessHostPreflight({ ...healthy(), listeners: null }).status, "block");
});

test("ss IPv4/IPv6 parsing strips addresses, zones and process identifiers", () => {
  const source = [
    "tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
    "tcp LISTEN 0 128 [::]:5432 [::]:* users:((secret-name,pid=99999,fd=3))",
    "udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*",
    "tcp LISTEN 0 128 [::1]:3000 [::]:*",
    "tcp LISTEN 0 128 [::ffff:127.0.0.1]:3000 [::]:*",
  ].join("\n");
  const result = parseHostListeners(source);
  assert.deepEqual(result, [
    { protocol: "tcp", port: 22, scope: "non-loopback" },
    { protocol: "udp", port: 53, scope: "loopback" },
    { protocol: "tcp", port: 3000, scope: "loopback" },
    { protocol: "tcp", port: 5432, scope: "non-loopback" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /127\.0|::|secret-name|99999/);
  assert.deepEqual(parseHostListeners(""), []);
  assert.throws(() => parseHostListeners("malformed private-data"), { message: "HOST_LISTENERS_UNREADABLE" });
});

test("network and security parsing keep only configuration presence and approved fields", () => {
  const network = parseHostNetworkPresence(JSON.stringify([
    { flags: ["LOOPBACK", "UP"], addr_info: [{ family: "inet", local: "127.0.0.1" }] },
    { flags: ["UP"], addr_info: [{ family: "inet6", local: "fe80::private-address" }] },
  ]));
  assert.deepEqual(network, { ipv4Configured: false, ipv6Configured: true });
  assert.throws(() => parseHostNetworkPresence("{}"), { message: "HOST_NETWORK_UNREADABLE" });
  const security = parseHostSecurity({ apparmor: "Y", ufw: "Status: active\nprivate source address", sshd:
    "permitrootlogin no\npasswordauthentication no\nkbdinteractiveauthentication no\npubkeyauthentication yes\nhostkey /private/host-key\n" });
  assert.deepEqual(security, healthy().security);
  assert.doesNotMatch(JSON.stringify({ network, security }), /private|127\.0|fe80/);
});

test("unknown security, address and timezone checks remain manual; unsafe SSH settings block", () => {
  const unknown = { ...healthy(), swapTotalBytes: null, swapFreeBytes: null, timezone: null,
    network: { ipv4Configured: null, ipv6Configured: null }, security: parseHostSecurity({ apparmor: null, ufw: null, sshd: null }) };
  assert.equal(assessHostPreflight(unknown).status, "warn");
  assert.ok(assessHostPreflight(unknown).checks.filter(item => /SWAP|TIMEZONE|IPV[46]|APPARMOR|UFW|SSH_/.test(item.code))
    .every(item => item.status === "warn"));
  const unsafe = { ...healthy(), security: parseHostSecurity({ apparmor: "N", ufw: "Status: inactive", sshd:
    "permitrootlogin prohibit-password\npasswordauthentication yes\nkbdinteractiveauthentication yes\npubkeyauthentication no\n" }) };
  assert.deepEqual(assessHostPreflight(unsafe).checks.filter(item => item.status === "block").map(item => item.code), [
    "APPARMOR_ENABLED", "SSH_ROOT_LOGIN_DISABLED", "SSH_PASSWORD_LOGIN_DISABLED", "SSH_INTERACTIVE_LOGIN_DISABLED", "SSH_PUBLIC_KEY_ENABLED",
  ]);
});

test("collector reads only local evidence and excludes environment/path/host identifiers", async () => {
  const report = await collectHostPreflight({ diskPath: tmpdir() });
  assert.equal(report.check, "mq-host-preflight");
  assert.ok(report.unverified.includes("CLOUD_AND_HOST_FIREWALL"));
  assert.ok(report.unverified.includes("EXTERNAL_IPV4_IPV6_PORTS"));
  assert.ok(Number.isFinite(report.sample.freeDiskBytes));
  assert.doesNotMatch(JSON.stringify(report), /DOCKER_HOST|HOME|cookie|"password":|password=|\/tmp|Users\\/i);
  if (platform() !== "linux") assert.equal(report.status, "block");
});

test("CLI rejects unexpected arguments with a fixed error, not their values", async () => {
  const result = await execute(process.execPath, ["scripts/production/host-preflight.mjs", "--secret=do-not-print"],
    { windowsHide: true }).then(() => assert.fail("expected nonzero"), error => error);
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim(), "MQ_HOST_PREFLIGHT_FAILED");
  assert.doesNotMatch(result.stdout + result.stderr, /do-not-print/);
});
