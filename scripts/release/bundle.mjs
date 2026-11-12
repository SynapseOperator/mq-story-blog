import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const TARGETS = Object.freeze(["app", "tools", "proxy", "operations"]);
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const limit = 8 * 1024 ** 3;

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

/** Read a bounded OCI tar without extracting anything. Hash every blob while
 * streaming; links, duplicate paths and non-OCI paths never reach docker load.
 * Supports the regular-file/directory USTAR exported by BuildKit/containerd. */
export async function inspectOciArchive(path, { sourceSha } = {}) {
  const stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 1024 && stat.size <= limit, "RELEASE_ARCHIVE_REJECTED");
  const file = await open(path, "r"), entries = new Map();
  const text = buffer => buffer.toString("utf8").split("\0")[0];
  let offset = 0, ended = false;
  try {
    while (offset + 512 <= stat.size) {
      const header = Buffer.alloc(512);
      assert.equal((await file.read(header, 0, 512, offset)).bytesRead, 512, "RELEASE_ARCHIVE_TRUNCATED");
      if (header.every(value => value === 0)) { ended = true; break; }
      const recorded = parseInt(text(header.subarray(148, 156)).trim(), 8);
      const sum = header.reduce((value, byte, index) => value + (index >= 148 && index < 156 ? 32 : byte), 0);
      assert.equal(recorded, sum, "RELEASE_TAR_CHECKSUM_REJECTED");
      const prefix = text(header.subarray(345, 500)), base = text(header.subarray(0, 100));
      const name = prefix ? `${prefix}/${base}` : base;
      const sizeString = text(header.subarray(124, 136)).trim();
      assert.match(sizeString, /^[0-7]+$/, "RELEASE_ARCHIVE_SIZE_REJECTED");
      const size = parseInt(sizeString, 8), type = header[156];
      assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= limit, "RELEASE_ARCHIVE_SIZE_REJECTED");
      assert.ok([0, 48, 53].includes(type) && !text(header.subarray(157, 257)), "RELEASE_ARCHIVE_LINK_REJECTED");
      assert.ok(/^(?:oci-layout|index\.json|manifest\.json|blobs\/?|blobs\/sha256\/?|blobs\/sha256\/[a-f0-9]{64})$/.test(name), "RELEASE_ARCHIVE_PATH_REJECTED");
      assert.ok(!entries.has(name) && entries.size < 1000, "RELEASE_ARCHIVE_DUPLICATE");
      assert.ok(offset + 512 + size <= stat.size, "RELEASE_ARCHIVE_TRUNCATED");
      if (type === 53) {
        assert.ok(size === 0 && /^blobs(?:\/sha256)?\/?$/.test(name), "RELEASE_ARCHIVE_DIRECTORY_REJECTED");
        entries.set(name, { size });
      } else {
        const hash = createHash("sha256"), chunks = [];
        if (size) for await (const chunk of createReadStream(path, { start: offset + 512, end: offset + 511 + size })) {
          hash.update(chunk); if (size <= 2 * 1024 ** 2) chunks.push(chunk);
        }
        const digest = hash.digest("hex");
        if (name.startsWith("blobs/sha256/")) assert.equal(digest, name.slice(13), "RELEASE_BLOB_DIGEST_REJECTED");
        entries.set(name, { size, digest: `sha256:${digest}`, bytes: size <= 2 * 1024 ** 2 ? Buffer.concat(chunks) : null });
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  } finally { await file.close(); }
  assert.ok(ended && entries.has("oci-layout") && entries.has("index.json"), "RELEASE_OCI_LAYOUT_REQUIRED");
  // End-of-archive padding cannot hide a second archive or unexpected files.
  const tail = createReadStream(path, { start: offset });
  for await (const bytes of tail) assert.ok(bytes.every(value => value === 0), "RELEASE_ARCHIVE_TRAILING_DATA");
  const parse = entry => { assert.ok(entry?.bytes, "RELEASE_OCI_METADATA_REJECTED"); return JSON.parse(entry.bytes.toString("utf8")); };
  assert.equal(parse(entries.get("oci-layout")).imageLayoutVersion, "1.0.0", "RELEASE_OCI_LAYOUT_REQUIRED");
  const index = parse(entries.get("index.json"));
  assert.ok(index.schemaVersion === 2 && index.manifests?.length === 1, "RELEASE_SINGLE_IMAGE_REQUIRED");
  const visited = new Set(), images = [];
  function blob(descriptor) {
    assert.match(descriptor.digest ?? "", digestPattern, "RELEASE_OCI_DESCRIPTOR_REJECTED");
    const entry = entries.get(`blobs/sha256/${descriptor.digest.slice(7)}`);
    assert.ok(entry && entry.size === descriptor.size, "RELEASE_OCI_BLOB_MISSING");
    return entry;
  }
  function visit(descriptor) {
    const entry = blob(descriptor);
    if (visited.has(descriptor.digest)) return;
    visited.add(descriptor.digest);
    const value = parse(entry);
    assert.equal(value.schemaVersion, 2, "RELEASE_OCI_MANIFEST_REJECTED");
    if (Array.isArray(value.manifests)) value.manifests.forEach(visit);
    else {
      assert.ok(Array.isArray(value.layers), "RELEASE_OCI_LAYERS_REJECTED");
      value.layers.forEach(blob);
      const config = parse(blob(value.config));
      if (config.os === "linux" && config.architecture === "amd64") images.push({ descriptor, config, configDigest: value.config.digest });
      else assert.equal(descriptor.annotations?.["vnd.docker.reference.type"], "attestation-manifest", "RELEASE_PLATFORM_REJECTED");
    }
  }
  visit(index.manifests[0]);
  assert.equal(images.length, 1, "RELEASE_SINGLE_PLATFORM_REQUIRED");
  const image = images[0];
  if (sourceSha) assert.equal(image.config.config?.Labels?.["org.opencontainers.image.revision"], sourceSha, "RELEASE_IMAGE_SOURCE_MISMATCH");
  assert.equal(image.config.config?.User, "10001:10001", "RELEASE_NONROOT_REQUIRED");
  assert.ok(!(image.config.config?.Env ?? []).some(value => /^(DATABASE_URL|AUTH_SECRET|SESSION_STORAGE_KEY|AUTH_PROXY_SECRET|MQ_.*SIGNING_KEY)=/.test(value)), "RELEASE_EMBEDDED_SECRET_REJECTED");
  return { archiveSha256: await hashFile(path), archiveBytes: stat.size,
    indexDigest: index.manifests[0].digest, manifestDigest: image.descriptor.digest,
    configDigest: image.configDigest, platform: "linux/amd64", user: "10001:10001" };
}

export async function releaseCompatibility(projectRoot) {
  const directory = join(projectRoot, "prisma", "migrations");
  const names = (await readdir(directory, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort();
  assert.equal(names.length, 10, "RELEASE_MIGRATION_REVIEW_REQUIRED");
  assert.equal(names[9], "202611120010_seven_story_stars", "RELEASE_MIGRATION_REVIEW_REQUIRED");
  const migrations = [];
  for (const name of names) migrations.push({ name, sha256: sha256(await readFile(join(directory, name, "migration.sql"))) });
  const files = ["prisma/schema.prisma", "scripts/production/database-policy.mjs", "scripts/production/runtime-config.mjs",
    "compose.production.yaml", "src/server/stories/content.ts", "src/server/auth/session-storage.ts", "src/server/auth/session-adapter.ts",
    "ops/Caddyfile.private", "scripts/production/caddy-entrypoint.sh",
    "scripts/release/production-plan.mjs", "scripts/release/production-host.mjs"];
  const contracts = {};
  for (const name of files) contracts[name] = sha256(await readFile(join(projectRoot, name)));
  return { migrations, contracts };
}

export async function createReleaseManifest({ directory, projectRoot, sourceSha, gate }) {
  assert.match(sourceSha ?? "", /^[a-f0-9]{40}$/, "RELEASE_SOURCE_REJECTED");
  assert.ok(gate?.kind === "reviewed-main" && gate.sourceSha === sourceSha, "RELEASE_GATE_REQUIRED");
  const images = {};
  for (const target of TARGETS) images[target] = { file: `${target}.oci.tar`, ...await inspectOciArchive(join(directory, `${target}.oci.tar`), { sourceSha }) };
  const release = { version: 1, sourceSha, platform: "linux/amd64", gate,
    compatibility: await releaseCompatibility(projectRoot), images, createdAt: new Date().toISOString() };
  const bytes = JSON.stringify(release, null, 2) + "\n";
  await writeFile(join(directory, "release.json"), bytes, { flag: "wx", mode: 0o444 });
  return { release, manifestSha256: sha256(bytes) };
}

/** Expected digest must come from the reviewed Actions run, not a sidecar in an
 * untrusted download. Hashes provide integrity; they are not an author signature. */
export async function verifyReleaseBundle(directory, expectedManifestSha256) {
  assert.match(expectedManifestSha256 ?? "", /^[a-f0-9]{64}$/, "RELEASE_EXPECTED_DIGEST_REQUIRED");
  const path = join(resolve(directory), "release.json"), stat = await lstat(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 64 * 1024, "RELEASE_MANIFEST_REJECTED");
  const bytes = await readFile(path);
  assert.equal(sha256(bytes), expectedManifestSha256, "RELEASE_MANIFEST_DIGEST_REJECTED");
  const release = JSON.parse(bytes.toString("utf8"));
  assert.ok(release.version === 1 && release.platform === "linux/amd64" && release.gate?.kind === "reviewed-main"
    && release.gate.sourceSha === release.sourceSha, "RELEASE_MANIFEST_REJECTED");
  assert.deepEqual(Object.keys(release.images).sort(), [...TARGETS].sort(), "RELEASE_IMAGES_REJECTED");
  for (const target of TARGETS) {
    assert.equal(release.images[target].file, `${target}.oci.tar`, "RELEASE_ARCHIVE_PATH_REJECTED");
    const actual = await inspectOciArchive(join(directory, `${target}.oci.tar`), { sourceSha: release.sourceSha });
    assert.deepEqual(release.images[target], { file: `${target}.oci.tar`, ...actual }, "RELEASE_ARCHIVE_CHANGED");
  }
  return release;
}
