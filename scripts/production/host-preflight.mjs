import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { availableParallelism, arch, freemem, platform, totalmem } from "node:os";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const GiB = 1024 ** 3;
const privatePorts = new Set([3000, 5432, 2019, 2375, 2376]);

/** Parse numeric ss output, discarding addresses, process names and host identity. */
export function parseHostListeners(output) {
  const listeners = [];
  for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
    const fields = line.trim().split(/\s+/);
    const match = fields[4]?.match(/^(.*):(\d+)$/);
    if (!["tcp", "udp"].includes(fields[0]) || !match) throw new Error("HOST_LISTENERS_UNREADABLE");
    const port = Number(match[2]);
    if (port < 1 || port > 65535) throw new Error("HOST_LISTENERS_UNREADABLE");
    const address = match[1].replace(/^\[|\]$/g, "").split("%")[0];
    const loopback = address === "::1" || /^(?:::ffff:)?127\.\d+\.\d+\.\d+$/i.test(address);
    const listener = { protocol: fields[0], port, scope: loopback ? "loopback" : "non-loopback" };
    if (!listeners.some(item => item.protocol === listener.protocol && item.port === port && item.scope === listener.scope)) listeners.push(listener);
  }
  return listeners.sort((left, right) => left.port - right.port || left.protocol.localeCompare(right.protocol));
}

export function parseHostNetworkPresence(output) {
  const interfaces = JSON.parse(output);
  if (!Array.isArray(interfaces) || interfaces.some(item => !Array.isArray(item.flags) || !Array.isArray(item.addr_info))) {
    throw new Error("HOST_NETWORK_UNREADABLE");
  }
  const addresses = interfaces.filter(item => !item.flags.includes("LOOPBACK")).flatMap(item => item.addr_info);
  return { ipv4Configured: addresses.some(item => item.family === "inet"), ipv6Configured: addresses.some(item => item.family === "inet6") };
}

export function parseHostSecurity({ apparmor, ufw, sshd }) {
  const setting = name => sshd?.match(new RegExp(`^${name} (\\S+)$`, "m"))?.[1] ?? null;
  const boolean = value => value === "yes" ? true : value === "no" ? false : null;
  const root = setting("permitrootlogin");
  return { apparmorEnabled: apparmor === "Y" ? true : apparmor === "N" ? false : null,
    ufwActive: /^Status: active$/m.test(ufw ?? "") ? true : /^Status: inactive$/m.test(ufw ?? "") ? false : null,
    ssh: { permitRootLogin: ["yes", "no", "prohibit-password", "forced-commands-only"].includes(root) ? root : null,
      passwordAuthentication: boolean(setting("passwordauthentication")),
      keyboardInteractiveAuthentication: boolean(setting("kbdinteractiveauthentication")),
      publicKeyAuthentication: boolean(setting("pubkeyauthentication")) } };
}

/** Resource readiness, not an assertion that SSH/firewall or production is safe. */
export function assessHostPreflight(sample) {
  const checks = [];
  const add = (code, status) => checks.push({ code, status });
  add("LINUX_REQUIRED", sample.platform === "linux" ? "pass" : "block");
  add("UBUNTU_24_04_REQUIRED", sample.osId === "ubuntu" && sample.osVersion === "24.04" ? "pass" : "block");
  add("RELEASE_ARCH_AMD64_REQUIRED", sample.architecture === "x64" ? "pass" : "block");
  add("NODE_24_REQUIRED", sample.nodeMajor === 24 ? "pass" : "block");
  add("CPU_CAPACITY", sample.cpuCount >= 4 ? "pass" : "warn");
  // The candidate's app/PG/proxy limits total 2432 MiB; leave host headroom.
  add("MEMORY_CAPACITY", !(sample.totalMemoryBytes >= 3 * GiB) ? "block" : sample.totalMemoryBytes < 3.5 * GiB ? "warn" : "pass");
  add("MEMORY_AVAILABLE", sample.freeMemoryBytes >= 256 * 1024 ** 2 ? "pass" : "block");
  add("SWAP_CAPACITY", sample.swapTotalBytes > 0 ? "pass" : "warn");
  add("SWAP_AVAILABLE", sample.swapFreeBytes === null ? "warn" : sample.swapTotalBytes > 0 && sample.swapFreeBytes === 0 ? "warn" : "pass");
  add("DISK_CAPACITY", sample.diskBytes >= 35 * GiB ? "pass" : "warn");
  add("DISK_RESERVE", sample.freeDiskBytes >= 8 * GiB ? "pass" : "block");
  add("INODE_RESERVE", sample.inodeFreePercent === null ? "warn" : sample.inodeFreePercent >= 5 ? "pass" : "block");
  add("TIME_SYNCHRONIZED", sample.timeSynchronized === null ? "warn" : sample.timeSynchronized ? "pass" : "block");
  add("TIMEZONE_KNOWN", sample.timezone === null ? "warn" : "pass");
  add("IPV4_CONFIGURED", sample.network.ipv4Configured === true ? "pass" : "warn");
  add("IPV6_CONFIGURED", sample.network.ipv6Configured === true ? "pass" : "warn");
  add("APPARMOR_ENABLED", sample.security.apparmorEnabled === null ? "warn" : sample.security.apparmorEnabled ? "pass" : "block");
  add("UFW_STATUS", sample.security.ufwActive === true ? "pass" : "warn");
  const ssh = sample.security.ssh;
  add("SSH_ROOT_LOGIN_DISABLED", ssh.permitRootLogin === null ? "warn" : ssh.permitRootLogin === "no" ? "pass" : "block");
  add("SSH_PASSWORD_LOGIN_DISABLED", ssh.passwordAuthentication === null ? "warn" : ssh.passwordAuthentication ? "block" : "pass");
  add("SSH_INTERACTIVE_LOGIN_DISABLED", ssh.keyboardInteractiveAuthentication === null ? "warn" : ssh.keyboardInteractiveAuthentication ? "block" : "pass");
  add("SSH_PUBLIC_KEY_ENABLED", ssh.publicKeyAuthentication === null ? "warn" : ssh.publicKeyAuthentication ? "pass" : "block");
  add("DOCKER_LOCAL_ENGINE", sample.tools.docker === null ? "warn" : "pass");
  add("COMPOSE_V2", sample.tools.compose === null ? "warn" : Number(sample.tools.compose.replace(/^v/, "").split(".")[0]) >= 2 ? "pass" : "block");
  if (sample.listeners === null) add("LISTENERS_UNVERIFIED", "block");
  else {
    add("PRIVATE_PORTS_NOT_EXPOSED", sample.listeners.some(item => item.scope === "non-loopback" && privatePorts.has(item.port)) ? "block" : "pass");
    add("INGRESS_PORTS_AVAILABLE", sample.listeners.some(item => [80, 443].includes(item.port)) ? "warn" : "pass");
    add("OTHER_LISTENERS_REVIEW", sample.listeners.some(item => item.scope === "non-loopback" && ![22, 80, 443].includes(item.port) && !privatePorts.has(item.port)) ? "warn" : "pass");
  }
  return { status: checks.some(item => item.status === "block") ? "block" : checks.some(item => item.status === "warn") ? "warn" : "pass", checks };
}

export async function collectHostPreflight({ diskPath = "/" } = {}) {
  if (!isAbsolute(diskPath)) throw new Error("HOST_DISK_PATH_REJECTED");
  const disk = await statfs(diskPath);
  const linux = platform() === "linux";
  const command = async (file, args) => {
    try {
      const result = await execute(file, args, { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024,
        env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" } });
      return result.stdout.trim();
    } catch { return null; }
  };
  let osId = null, osVersion = null, memoryAvailable = freemem(), swapTotalBytes = null, swapFreeBytes = null;
  if (linux) {
    const release = await readFile("/etc/os-release", "utf8");
    osId = release.match(/^ID="?([a-z0-9_-]+)"?$/m)?.[1] ?? null;
    osVersion = release.match(/^VERSION_ID="?([\d.]+)"?$/m)?.[1] ?? null;
    const memory = await readFile("/proc/meminfo", "utf8");
    const available = memory.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (available) memoryAvailable = Number(available[1]) * 1024;
    const swapTotal = memory.match(/^SwapTotal:\s+(\d+)\s+kB$/m), swapFree = memory.match(/^SwapFree:\s+(\d+)\s+kB$/m);
    if (swapTotal && swapFree) { swapTotalBytes = Number(swapTotal[1]) * 1024; swapFreeBytes = Number(swapFree[1]) * 1024; }
  }
  // Pin Docker to the local socket; inherited DOCKER_HOST/contexts cannot make
  // this host inspection contact another machine. No sudo or mutation is used.
  const [time, timezoneValue, sockets, interfaces, apparmor, ufw, sshd, docker, compose] = linux ? await Promise.all([
    command("timedatectl", ["show", "--property=NTPSynchronized", "--value"]),
    command("timedatectl", ["show", "--property=Timezone", "--value"]),
    command("ss", ["-H", "-lntu"]),
    command("ip", ["-j", "address", "show"]),
    readFile("/sys/module/apparmor/parameters/enabled", "utf8").then(value => value.trim(), () => null),
    command("ufw", ["status"]),
    command("sshd", ["-T"]),
    command("docker", ["--host", "unix:///var/run/docker.sock", "version", "--format", "{{.Server.Version}}"]),
    command("docker", ["--host", "unix:///var/run/docker.sock", "compose", "version", "--short"]),
  ]) : Array(9).fill(null);
  let listeners = null;
  if (sockets !== null) {
    try { listeners = parseHostListeners(sockets); } catch { /* Fixed blocking code, never raw ss output. */ }
  }
  let network = { ipv4Configured: null, ipv6Configured: null };
  if (interfaces !== null) {
    try { network = parseHostNetworkPresence(interfaces); } catch { /* No addresses or raw JSON in reports. */ }
  }
  const timezone = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezoneValue ?? "") && timezoneValue.length <= 80 ? timezoneValue : null;
  const version = value => /^v?\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/.test(value ?? "") ? value : null;
  const sample = { platform: platform(), osId, osVersion, architecture: arch(), nodeMajor: Number(process.versions.node.split(".")[0]),
    cpuCount: availableParallelism(), totalMemoryBytes: totalmem(), freeMemoryBytes: memoryAvailable, swapTotalBytes, swapFreeBytes,
    diskBytes: disk.blocks * disk.bsize, freeDiskBytes: disk.bavail * disk.bsize,
    inodeFreePercent: disk.files > 0 ? 100 * disk.ffree / disk.files : null,
    timeSynchronized: time === "yes" ? true : time === "no" ? false : null, timezone, network,
    security: parseHostSecurity({ apparmor, ufw, sshd }),
    tools: { docker: version(docker), compose: version(compose) }, listeners };
  return { check: "mq-host-preflight", checkedAt: new Date().toISOString(), ...assessHostPreflight(sample), sample,
    unverified: ["SSH_ACCESS_POLICY", "CLOUD_AND_HOST_FIREWALL", "EXTERNAL_IPV4_IPV6_PORTS", "PROVIDER_CAPACITY_AND_BILLING", "PRODUCTION_SECURITY_REVIEW"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args[0] && !args[0].startsWith("--disk-path="))) throw new Error("HOST_ARGUMENTS_REJECTED");
    const report = await collectHostPreflight({ diskPath: args[0]?.slice("--disk-path=".length) ?? "/" });
    console.log(JSON.stringify(report));
    process.exitCode = report.status === "block" ? 1 : report.status === "warn" ? 2 : 0;
  } catch { console.error("MQ_HOST_PREFLIGHT_FAILED"); process.exitCode = 1; }
}
