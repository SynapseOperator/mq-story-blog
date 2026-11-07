import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { assessHostPreflight } from "./host-preflight.mjs";

const integerFields = ["cpuCount", "totalMemoryBytes", "freeMemoryBytes", "swapTotalBytes", "swapFreeBytes", "diskBytes", "freeDiskBytes", "inodeCount", "freeInodeCount", "nodeMajor"];
const booleanFields = ["timeSynchronized", "apparmorEnabled", "ufwActive", "sshConnectionContext", "sshHostMatchVerified", "ipv4Configured", "ipv6Configured", "ipv6GlobalConfigured", "listenersKnown"];
const serviceFields = ["apparmorService", "sshService", "sshSocket", "sshSocketEnabled"];
const sshProperties = ["permitRootLogin", "passwordAuthentication", "keyboardInteractiveAuthentication", "publicKeyAuthentication"];
const sshFields = ["default", "connection", "root"].flatMap(context => sshProperties.map(property => `ssh.${context}.${property}`));
const expectedFields = new Set(["version", "checkedAt", "privilegedRequested", "platform", "osId", "osVersion", "architecture", "load1", "load5", "load15", "timezone", "dockerVersion", "composeVersion", ...integerFields, ...booleanFields, ...serviceFields, ...sshFields]);
const serviceStates = new Set(["active", "inactive", "failed", "activating", "deactivating", "enabled", "disabled", "static", "masked", "indirect", "generated", "enabled-runtime"]);
const resourceChecks = new Set(["LINUX_REQUIRED", "UBUNTU_24_04_REQUIRED", "RELEASE_ARCH_AMD64_REQUIRED", "CPU_CAPACITY", "MEMORY_CAPACITY", "MEMORY_AVAILABLE", "SWAP_CAPACITY", "SWAP_AVAILABLE", "DISK_CAPACITY", "DISK_RESERVE", "INODE_RESERVE"]);
const overall = checks => checks.some(item => item.status === "block") ? "block" : checks.some(item => item.status === "warn") ? "warn" : "pass";
const rejected = () => { throw new Error("NATIVE_HOST_REPORT_REJECTED"); };

/** Accept only the native collector's bounded, address-free TSV protocol. */
export function parseNativeHostPreflight(input) {
  if (typeof input !== "string" || Buffer.byteLength(input) > 65536) rejected();
  const fields = new Map(), listeners = [];
  for (const line of input.replace(/\r\n/g, "\n").split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length !== 2) rejected();
    const [key, raw] = parts;
    if (key === "listener") {
      const match = /^(tcp|udp),([1-9][0-9]{0,4}),(loopback|non-loopback)$/.exec(raw);
      if (!match || Number(match[2]) > 65535 || listeners.length >= 512) rejected();
      const listener = { protocol: match[1], port: Number(match[2]), scope: match[3] };
      if (listeners.some(item => item.protocol === listener.protocol && item.port === listener.port && item.scope === listener.scope)) rejected();
      listeners.push(listener);
      continue;
    }
    if (!expectedFields.has(key) || fields.has(key) || !raw || raw.length > 80) rejected();
    let value = raw === "unknown" ? null : raw;
    if (value !== null) {
      if (integerFields.includes(key) || /^load(1|5|15)$/.test(key)) {
        const pattern = integerFields.includes(key) ? /^(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
        if (!pattern.test(raw) || !Number.isFinite(Number(raw)) || Number(raw) > Number.MAX_SAFE_INTEGER) rejected();
        value = Number(raw);
      } else if (booleanFields.includes(key) || (sshFields.includes(key) && !key.endsWith("permitRootLogin"))) {
        if (!["true", "false"].includes(raw)) rejected();
        value = raw === "true";
      } else if (serviceFields.includes(key)) {
        if (!serviceStates.has(raw)) rejected();
      } else if (key.endsWith("permitRootLogin")) {
        if (!["yes", "no", "prohibit-password", "forced-commands-only"].includes(raw)) rejected();
      } else {
        const patterns = { version: /^1$/, checkedAt: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, privilegedRequested: /^(yes|no)$/,
          platform: /^(linux|darwin|freebsd)$/, osId: /^[a-z][a-z0-9_-]{0,30}$/, osVersion: /^\d+(?:\.\d+){0,2}$/,
          architecture: /^(x86_64|aarch64|armv7l|i686|ppc64le|s390x|riscv64)$/, timezone: /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*$/,
          dockerVersion: /^v?\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/, composeVersion: /^v?\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?$/ };
        if (!patterns[key]?.test(raw)) rejected();
      }
    }
    fields.set(key, value);
  }
  if (fields.size !== expectedFields.size || fields.get("version") !== "1" || !Number.isFinite(Date.parse(fields.get("checkedAt"))) || fields.get("privilegedRequested") === null) rejected();
  if (fields.get("listenersKnown") !== true && listeners.length) rejected();
  const get = key => fields.get(key);
  const ssh = context => Object.fromEntries(sshProperties.map(property => [property, get(`ssh.${context}.${property}`)]));
  const sample = { platform: get("platform"), osId: get("osId"), osVersion: get("osVersion"),
    architecture: ({ x86_64: "x64", aarch64: "arm64" })[get("architecture")] ?? get("architecture"),
    ...Object.fromEntries(integerFields.filter(key => !["inodeCount", "freeInodeCount"].includes(key)).map(key => [key, get(key)])),
    inodeFreePercent: get("inodeCount") > 0 && get("freeInodeCount") !== null ? 100 * get("freeInodeCount") / get("inodeCount") : null,
    timezone: get("timezone"), timeSynchronized: get("timeSynchronized"),
    network: { ipv4Configured: get("ipv4Configured"), ipv6Configured: get("ipv6Configured"), ipv6GlobalConfigured: get("ipv6GlobalConfigured") },
    security: { apparmorEnabled: get("apparmorEnabled"), ufwActive: get("ufwActive"), ssh: ssh("connection") },
    tools: { docker: get("dockerVersion"), compose: get("composeVersion") }, listeners: get("listenersKnown") === true ? listeners : null };
  const { checks } = assessHostPreflight(sample);
  checks.push({ code: "SSH_CURRENT_CONNECTION_MATCH", status: get("sshConnectionContext") === true && get("sshHostMatchVerified") === true && sshProperties.every(property => get(`ssh.connection.${property}`) !== null) ? "pass" : "warn" });
  const rootSetting = get("ssh.root.permitRootLogin");
  checks.push({ code: "SSH_ROOT_MATCH_LOGIN_DISABLED", status: rootSetting === null ? "warn" : rootSetting === "no" ? "pass" : "block" });
  const hardwareChecks = checks.filter(item => resourceChecks.has(item.code));
  return { check: "mq-host-native", checkedAt: get("checkedAt"), status: overall(checks), checks,
    hardware: { status: overall(hardwareChecks), checks: hardwareChecks }, sample,
    native: { privilegedRequested: get("privilegedRequested") === "yes", load: [get("load1"), get("load5"), get("load15")],
      inodeCount: get("inodeCount"), freeInodeCount: get("freeInodeCount"),
      services: Object.fromEntries(serviceFields.map(key => [key, get(key)])),
      ssh: { connectionContext: get("sshConnectionContext"), hostMatchVerified: get("sshHostMatchVerified"), defaults: ssh("default"), root: ssh("root") } },
    unverified: ["CLOUD_FIREWALL", "EXTERNAL_IPV4_IPV6_PORTS", "SSH_OTHER_SOURCE_MATCH_RULES", "DOCKER_PUBLISHED_PORT_FIREWALL", "FILESYSTEM_LAYOUT_AND_VOLUME_CAPACITY", "PROVIDER_CAPACITY_AND_BILLING", "PRODUCTION_SECURITY_REVIEW"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1) rejected();
    let input;
    if (args.length) input = await readFile(args[0], "utf8");
    else {
      input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) rejected(); }
    }
    const report = parseNativeHostPreflight(input);
    console.log(JSON.stringify(report));
    process.exitCode = report.status === "block" ? 1 : report.status === "warn" ? 2 : 0;
  } catch { console.error("MQ_NATIVE_HOST_IMPORT_FAILED"); process.exitCode = 1; }
}
