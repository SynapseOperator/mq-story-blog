import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statfs, readFile, realpath, lstat } from "node:fs/promises";
import { availableParallelism, freemem, totalmem, loadavg } from "node:os";
import { isAbsolute } from "node:path";
import tls from "node:tls";
import https from "node:https";
import { setTimeout, clearTimeout } from "node:timers";
import { pathToFileURL, URL } from "node:url";

// Read-only host probe. It never prints inspect Env, container logs, URLs,
// certificate subject names, credentials, or response bodies.
export function assessOperations(sample) {
  const failures = [];
  if (sample.freeBytes < sample.reserveBytes) failures.push("DISK_RESERVE_LOW");
  if (sample.inodes > 0 && sample.freeInodes / sample.inodes < 0.05) failures.push("INODES_LOW");
  if (sample.freeMemoryBytes < 256 * 1024 * 1024) failures.push("HOST_MEMORY_LOW");
  if (sample.loadPerCpu > 1.5) failures.push("HOST_LOAD_HIGH");
  if (!Number.isFinite(sample.certificateDays) || sample.certificateDays < 14) failures.push("TLS_EXPIRY_OR_VERIFICATION_FAILED");
  if (sample.httpAvailable !== true) failures.push("HTTPS_UNAVAILABLE");
  if (!Number.isFinite(sample.backupAgeHours) || sample.backupAgeHours < -0.1 || sample.backupAgeHours > 26) failures.push("BACKUP_MISSING_OR_STALE");
  for (const name of ["app", "postgres", "proxy"]) {
    const service = sample.services.filter(item => item.name === name);
    if (service.length !== 1 || !service[0].running || service[0].oom
      || (name !== "proxy" && service[0].health !== "healthy")) failures.push(`${name.toUpperCase()}_UNHEALTHY`);
    if (service.some(item => item.exposed && name !== "proxy")) failures.push(`${name.toUpperCase()}_PORT_EXPOSED`);
    if (service.some(item => item.memoryPercent >= 90)) failures.push(`${name.toUpperCase()}_MEMORY_HIGH`);
  }
  return { ok: failures.length === 0, failures };
}

export function certificateDays(origin, { ca, connectHost } = {}) {
  const target = new URL(origin);
  assert.equal(target.protocol, "https:");
  assert.ok(!target.username && !target.password && !target.search && !target.hash && target.pathname === "/");
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: connectHost ?? target.hostname, port: Number(target.port || 443),
      servername: target.hostname, ca, rejectUnauthorized: true }, () => {
      const expiry = Date.parse(socket.getPeerCertificate().valid_to);
      socket.end(); resolve((expiry - Date.now()) / 86400000);
    });
    socket.setTimeout(10000, () => socket.destroy(new Error("OPS_TLS_TIMEOUT")));
    socket.once("error", () => reject(new Error("OPS_TLS_FAILED")));
  });
}

/** Checks the application's existing public database-backed endpoint, not just
 * an open TLS socket. No redirects, credentials or response content in output. */
export async function collectExternalAvailability({ origin, ca, connectHost, timeoutMs = 5000 }) {
  const target = new URL(origin);
  assert.ok(target.protocol === "https:" && target.pathname === "/" && !target.username && !target.password && !target.search && !target.hash);
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 50 && timeoutMs <= 10000);
  const sample = await new Promise(resolve => {
    let request;
    const timer = setTimeout(() => request?.destroy(new Error("OPS_HTTP_TIMEOUT")), timeoutMs);
    const finish = value => { clearTimeout(timer); resolve(value); };
    request = https.get(new URL("/api/stories", target), { ca, rejectUnauthorized: true, agent: false,
      ...(connectHost ? { hostname: connectHost, servername: target.hostname } : {}),
      // A tunnel may change the socket destination, never the virtual host.
      headers: { host: target.host, accept: "application/json", "user-agent": "mq-operations/1" } }, response => {
      const expiry = Date.parse(response.socket.getPeerCertificate().valid_to);
      const certificateDays = (expiry - Date.now()) / 86400000;
      if (response.statusCode !== 200 || !/^application\/json(?:;|$)/i.test(response.headers["content-type"] ?? "")) {
        finish({ certificateDays, httpAvailable: false }); response.destroy(); return;
      }
      let bytes = 0; const chunks = [];
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 65536) { finish({ certificateDays, httpAvailable: false }); response.destroy(); }
        else chunks.push(chunk);
      });
      response.once("end", () => {
        let httpAvailable = false;
        try { httpAvailable = Array.isArray(JSON.parse(Buffer.concat(chunks).toString("utf8")).stories); } catch { /* Fixed result only. */ }
        finish({ certificateDays, httpAvailable });
      });
      response.once("error", () => finish({ certificateDays, httpAvailable: false }));
      response.once("aborted", () => finish({ certificateDays, httpAvailable: false }));
    });
    request.once("error", () => finish({ certificateDays: null, httpAvailable: false }));
  });
  const failures = [];
  if (!Number.isFinite(sample.certificateDays) || sample.certificateDays < 14) failures.push("TLS_EXPIRY_OR_VERIFICATION_FAILED");
  if (!sample.httpAvailable) failures.push("HTTPS_UNAVAILABLE");
  return { ok: failures.length === 0, failures, sample };
}

export async function collectOperations({ project, deploymentId, diskPath, origin, receiptPath, reserveBytes = 8 * 1024 ** 3, ca, connectHost }) {
  assert.match(project ?? "", /^mq-[a-z0-9][a-z0-9-]{1,80}$/);
  assert.match(deploymentId ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.ok(isAbsolute(diskPath));
  assert.ok(!(await lstat(diskPath)).isSymbolicLink());
  const disk = await statfs(await realpath(diskPath));
  const command = args => {
    const result = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error("OPS_DOCKER_UNAVAILABLE");
    return result.stdout.trim();
  };
  const ids = command(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"])
    .split(/\r?\n/).filter(Boolean);
  const services = [];
  for (const id of ids) {
    assert.match(id, /^[a-f0-9]{12,64}$/);
    const info = JSON.parse(command(["inspect", "--format", '{"name":{{json (index .Config.Labels "com.docker.compose.service")}},"state":{{json .State}},"ports":{{json .HostConfig.PortBindings}}}', id]));
    if (!["app", "postgres", "proxy"].includes(info.name)) continue;
    const usage = info.state.Running ? JSON.parse(command(["stats", "--no-stream", "--format", "{{json .MemPerc}}", id])) : "0%";
    services.push({ name: info.name, running: info.state.Running, health: info.state.Health?.Status,
      oom: info.state.OOMKilled, exposed: Object.values(info.ports ?? {}).some(bindings => bindings?.length), memoryPercent: parseFloat(usage) });
  }
  let backupAgeHours = NaN;
  if (receiptPath) {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    // A receipt is emitted only after backup integrity verification, never after
    // merely starting a job. It is operational evidence, not an offsite copy.
    if (receipt.verified === true && receipt.deploymentId === deploymentId && /^[a-f0-9]{64}$/.test(receipt.snapshotId ?? "")) backupAgeHours = (Date.now() - Date.parse(receipt.completedAt)) / 3600000;
  }
  const availability = await collectExternalAvailability({ origin, ca, connectHost });
  const sample = { freeBytes: disk.bavail * disk.bsize, reserveBytes, inodes: disk.files, freeInodes: disk.ffree,
    freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), loadPerCpu: loadavg()[0] / availableParallelism(),
    ...availability.sample, backupAgeHours, services };
  return { ...assessOperations(sample), sample };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deploymentId = process.env.MQ_OPS_DEPLOYMENT_ID;
  try {
    const external = process.argv.length === 3 && process.argv[2] === "--external";
    assert.ok(process.argv.length === 2 || external);
    assert.match(deploymentId ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    const result = external ? await collectExternalAvailability({ origin: process.env.MQ_OPS_ORIGIN })
      : await collectOperations({ project: process.env.MQ_OPS_PROJECT, deploymentId, diskPath: process.env.MQ_OPS_DISK_PATH,
        origin: process.env.MQ_OPS_ORIGIN, receiptPath: process.env.MQ_OPS_BACKUP_RECEIPT });
    console.log(JSON.stringify({ check: external ? "mq-external" : "mq-operations", deploymentId, checkedAt: new Date().toISOString(), ...result }));
    if (!result.ok) process.exitCode = 1;
  } catch {
    // An unavailable probe still produces a current, safe notification report.
    // An invalid/missing target identifier must not invent a deployment identity.
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(deploymentId ?? "")) {
      console.log(JSON.stringify({ check: "mq-operations", deploymentId, checkedAt: new Date().toISOString(),
        ok: false, failures: ["OPERATIONS_CHECK_FAILED"] }));
    }
    console.error("MQ_OPERATIONS_CHECK_FAILED"); process.exitCode = 1;
  }
}
