import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCANNER = "ghcr.io/aquasecurity/trivy@sha256:6fa071ef8daa2e58b90cbf1710bedca91adbb3bf98693533226f442035b836a6";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const names = ["app", "proxy", "tools", "operations", "postgres"];
const defaults = {
  app: "mq-p302-app:local", proxy: "mq-p302-proxy:local", tools: "mq-p302-tools:local",
  operations: "mq-p303-operations:local",
  postgres: "postgres:18.6-bookworm@sha256:f1ea2a1a4fb7b68d4836be1fdcb8a6466a89b072158bf9d97663600538c294c5",
};

/** Counts every result; severity, fix availability and reachability are different
 * facts. No suppression or ignore-unfixed option is used by this command. */
export function summarizeImageScan(report, configDigest, exitCode) {
  assert.equal(report.Metadata?.ImageID, configDigest, "SCAN_IMAGE_PROVENANCE_MISMATCH");
  assert.ok(Array.isArray(report.Results), "SCAN_RESULTS_REQUIRED");
  assert.ok([0, 1].includes(exitCode), "SCAN_TOOL_FAILED");
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  const highCritical = [];
  let fixableHighCritical = 0;
  for (const result of report.Results) for (const item of result.Vulnerabilities ?? []) {
    assert.ok(Object.hasOwn(counts, item.Severity), "SCAN_SEVERITY_UNKNOWN");
    counts[item.Severity]++;
    if (["HIGH", "CRITICAL"].includes(item.Severity)) {
      if (item.FixedVersion) fixableHighCritical++;
      highCritical.push({ target: result.Target, package: item.PkgName, packagePath: item.PkgPath ?? null,
        id: item.VulnerabilityID, severity: item.Severity, installed: item.InstalledVersion,
        fixed: item.FixedVersion ?? null, url: item.PrimaryURL ?? null });
    }
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  assert.equal(exitCode, total ? 1 : 0, "SCAN_EXIT_RESULT_MISMATCH");
  return { exitCode, counts, fixableHighCritical, highCritical };
}

function execute(command, args, { accepted = [0], timeout = 12 * 60_000, recordFile } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 8 * 1024 ** 2 });
  if (recordFile) writeFileSync(recordFile, JSON.stringify({ exitCode: result.status, signal: result.signal,
    errorCode: result.error?.code ?? null, stdout: result.stdout, stderr: result.stderr }, null, 2));
  assert.ok(!result.error && accepted.includes(result.status), "IMAGE_SCAN_COMMAND_FAILED");
  return result;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function imageBuildInputs() {
  // A conservative set covering the .dockerignore allowlist; ignored local
  // credentials/generated output are never read. Extra non-input files within
  // these directories may change this digest, which safely requires rechecking.
  const files = execute("git", ["-C", project, "ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .stdout.split("\0").filter(name => name && (/^(?:src|public|prisma|scripts|tests|config|ops)\//.test(name)
      || [".dockerignore", "Dockerfile", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json",
        "eslint.config.mjs", "postcss.config.mjs", "prisma.config.ts"].includes(name))).sort();
  const entries = [];
  for (const path of files) entries.push({ path, sha256: await hashFile(join(project, path)) });
  return { sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), files: entries };
}

/** The archive was just exported by local Docker from an immutable inspected
 * image ID. Read only its metadata; do not extract layers or execute the image. */
export function inspectScanArchive(archive) {
  const manifest = JSON.parse(execute("tar", ["-xOf", archive, "manifest.json"]).stdout);
  assert.equal(manifest.length, 1, "SCAN_SINGLE_IMAGE_REQUIRED");
  const configPath = manifest[0].Config;
  assert.match(configPath, /^(?:blobs\/sha256\/[a-f0-9]{64}|[a-f0-9]{64}\.json)$/);
  const bytes = execute("tar", ["-xOf", archive, configPath]).stdout;
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.ok(configPath.includes(digest), "SCAN_CONFIG_DIGEST_MISMATCH");
  const config = JSON.parse(bytes);
  assert.equal(config.os, "linux");
  assert.equal(config.architecture, "amd64");
  return { configDigest: `sha256:${digest}`, sourceSha: config.config?.Labels?.["org.opencontainers.image.revision"] ?? null };
}

export async function scanImages({ directory, images = defaults }) {
  assert.ok(isAbsolute(directory), "SCAN_ABSOLUTE_OUTPUT_REQUIRED");
  const output = resolve(directory), fromProject = relative(project, output);
  assert.ok(fromProject === ".." || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject),
    "SCAN_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  assert.ok(!output.includes(","), "SCAN_OUTPUT_PATH_REJECTED");
  assert.deepEqual(Object.keys(images).sort(), [...names].sort(), "SCAN_FIVE_IMAGES_REQUIRED");
  await mkdir(output, { mode: 0o700 }); // New evidence only; never overwrite an earlier run.
  for (const folder of ["archives", "reports", "cache"]) await mkdir(join(output, folder), { mode: 0o700 });
  const ledger = { version: 1, startedAt: new Date().toISOString(), scanner: SCANNER,
    sourceHead: execute("git", ["-C", project, "rev-parse", "HEAD"]).stdout.trim(),
    sourceDirty: Boolean(execute("git", ["-C", project, "status", "--porcelain"]).stdout.trim()),
    buildInputs: await imageBuildInputs(), database: null, images: {}, stage: "database-download", completed: false };
  const save = () => writeFile(join(output, "scan.json"), JSON.stringify(ledger, null, 2));
  await save();
  const uid = process.getuid?.() ?? 10001, gid = process.getgid?.() ?? 10001;
  assert.ok(uid > 0, "SCAN_RUN_AS_NONROOT_REQUIRED");
  const isolated = ["run", "--rm", "--read-only", "--user", `${uid}:${gid}`, "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--memory", "1536m", "--cpus", "2",
    "--tmpfs", `/tmp:rw,nosuid,size=768m,uid=${uid},gid=${gid},mode=0700`];
  // Only the vulnerability cache is mounted while network access is allowed.
  const download = execute("docker", [...isolated, "--mount", `type=bind,source=${join(output, "cache")},target=/cache`,
    SCANNER, "image", "--download-db-only", "--cache-dir", "/cache", "--disable-telemetry", "--no-progress"],
  { accepted: [0, 1], recordFile: join(output, "database-download.command.json") });
  await writeFile(join(output, "database-download.log"), download.stdout + download.stderr);
  ledger.databaseDownloadExit = download.status;
  await save();
  assert.equal(download.status, 0, "SCAN_DATABASE_DOWNLOAD_FAILED");
  ledger.database = JSON.parse(await readFile(join(output, "cache", "db", "metadata.json"), "utf8"));
  for (const name of names) {
    ledger.stage = `${name}:inspect-and-export`;
    await save();
    const [image] = JSON.parse(execute("docker", ["image", "inspect", images[name]]).stdout);
    assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(image.Os, "linux"); assert.equal(image.Architecture, "amd64");
    const archive = join(output, "archives", `${name}.tar`);
    execute("docker", ["image", "save", "--output", archive, image.Id],
      { recordFile: join(output, "reports", `${name}-export.command.json`) });
    const provenance = inspectScanArchive(archive);
    const item = { requested: images[name], imageId: image.Id, descriptor: image.Descriptor ?? null,
      ...provenance, archiveBytes: (await stat(archive)).size, archiveSha256: await hashFile(archive) };
    ledger.images[name] = item;
    ledger.stage = `${name}:offline-scan`;
    await save();
    // No network, source, credentials, telemetry or Docker socket during analysis.
    const result = execute("docker", [...isolated, "--network", "none",
      "--mount", `type=bind,source=${join(output, "archives")},target=/archives,readonly`,
      "--mount", `type=bind,source=${join(output, "reports")},target=/reports`,
      "--mount", `type=bind,source=${join(output, "cache")},target=/cache`, SCANNER,
      "image", "--input", `/archives/${name}.tar`, "--cache-dir", "/cache", "--scanners", "vuln",
      "--skip-db-update", "--skip-java-db-update", "--offline-scan", "--disable-telemetry",
      "--parallel", "1", "--timeout", "10m", "--no-progress", "--format", "json",
      "--output", `/reports/${name}.json`, "--exit-code", "1"],
    { accepted: [0, 1], recordFile: join(output, "reports", `${name}-scan.command.json`) });
    await writeFile(join(output, "reports", `${name}.log`), result.stdout + result.stderr);
    item.rawExitCode = result.status;
    await save();
    item.result = summarizeImageScan(JSON.parse(await readFile(join(output, "reports", `${name}.json`), "utf8")),
      provenance.configDigest, result.status);
    await save();
  }
  ledger.completed = true;
  assert.equal((await imageBuildInputs()).sha256, ledger.buildInputs.sha256, "SCAN_SOURCE_CHANGED_DURING_RUN");
  ledger.stage = "complete";
  ledger.completedAt = new Date().toISOString();
  ledger.exitCode = Object.values(ledger.images).some(item => item.rawExitCode === 1) ? 1 : 0;
  await save();
  return ledger;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = Object.fromEntries(process.argv.slice(2).map(arg => {
      const match = /^--(output|app|proxy|tools|operations|postgres)=(.+)$/.exec(arg);
      assert.ok(match, "SCAN_ARGUMENT_REJECTED"); return [match[1], match[2]];
    }));
    const { output, ...overrides } = options;
    const result = await scanImages({ directory: output, images: { ...defaults, ...overrides } });
    console.log(JSON.stringify({ completed: result.completed, exitCode: result.exitCode,
      results: Object.fromEntries(names.map(name => [name, result.images[name].result.counts])) }));
    process.exitCode = result.exitCode;
  } catch {
    console.error("IMAGE_SCAN_INCOMPLETE; preserve the evidence directory and inspect its recorded stage");
    process.exitCode = 2;
  }
}
