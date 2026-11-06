import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statfs, readFile, realpath, lstat } from "node:fs/promises";
import { availableParallelism, freemem, totalmem, loadavg } from "node:os";
import { isAbsolute } from "node:path";
import tls from "node:tls";
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
  let days = NaN;
  try { days = await certificateDays(origin, { ca, connectHost }); } catch { /* Fixed alert below; never weaken certificate validation. */ }
  const sample = { freeBytes: disk.bavail * disk.bsize, reserveBytes, inodes: disk.files, freeInodes: disk.ffree,
    freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), loadPerCpu: loadavg()[0] / availableParallelism(),
    certificateDays: days, backupAgeHours, services };
  return { ...assessOperations(sample), sample };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await collectOperations({ project: process.env.MQ_OPS_PROJECT, deploymentId: process.env.MQ_OPS_DEPLOYMENT_ID, diskPath: process.env.MQ_OPS_DISK_PATH,
      origin: process.env.MQ_OPS_ORIGIN, receiptPath: process.env.MQ_OPS_BACKUP_RECEIPT });
    console.log(JSON.stringify({ check: "mq-operations", checkedAt: new Date().toISOString(), ...result }));
    if (!result.ok) process.exitCode = 1;
  } catch { console.error("MQ_OPERATIONS_CHECK_FAILED"); process.exitCode = 1; }
}
