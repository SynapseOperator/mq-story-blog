import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeMediaVolume } from "../scripts/production/init-media.mjs";
import { createLocalMediaStore, mediaConfigurationFromEnvironment } from "../src/server/media/local-store.ts";

const reserve = 256 * 1024 * 1024;
const initializationRejected = /^Error: DEPLOYMENT_MEDIA_INITIALIZATION_REJECTED$/;
const storageCode = code => error => error.code === code && error.message === code;

async function fixture(t, environment = "staging") {
  const sandbox = await fs.mkdtemp(join(tmpdir(), "mq-production-media-"));
  const projectRoot = join(sandbox, "repository"), root = join(sandbox, "private-media");
  await fs.mkdir(projectRoot, { mode: 0o700 }); await fs.mkdir(join(projectRoot, ".git"));
  await fs.mkdir(root, { mode: 0o700 });
  const marker = join(root, ".mq-deployment.json"), deploymentId = randomUUID();
  // UID is an injected unit-test input on non-service CI users, never evidence
  // that those users own a production volume. Container tests use real UID10001.
  if (process.platform !== "win32" && process.geteuid() !== 10001) {
    const original = fs.lstat;
    t.mock.method(process, "geteuid", () => 10001);
    const owner = t.mock.method(fs, "lstat", async (...args) => {
      const info = await original(...args);
      if ([root, marker].includes(args[0])) info.uid = 10001;
      return info;
    });
    syncBuiltinESMExports();
    t.after(() => { owner.mock.restore(); syncBuiltinESMExports(); });
  }
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  const config = { version: 1, environment, deploymentId, media: { root, minFreeBytes: reserve } };
  const media = { projectRoot, root, environment, deploymentId, maxVariantBytes: 1024, minimumFreeBytes: reserve };
  return { sandbox, projectRoot, root, marker, config, media };
}

test("media initialization stamps only a pre-created empty volume and remains idempotent", async t => {
  const { config, projectRoot, marker, root, media } = await fixture(t);
  assert.deepEqual(await initializeMediaVolume(config, { projectRoot }), { initialized: true });
  const identity = await fs.readFile(marker, "utf8");
  assert.deepEqual(JSON.parse(identity), { version: 1, environment: config.environment, deploymentId: config.deploymentId });
  const store = await createLocalMediaStore(media), key = randomUUID();
  await store.write(key, "display", Buffer.from("synthetic processed image"));
  await initializeMediaVolume(config, { projectRoot });
  assert.equal(await fs.readFile(marker, "utf8"), identity);
  assert.deepEqual((await fs.readdir(root)).sort(), [".mq-deployment.json", key].sort());
  assert.equal((await store.read(key, "display")).toString(), "synthetic processed image");
});

test("initialization refuses missing, nonempty, project, Git and aliased roots without modifying them", async t => {
  const { config, projectRoot, root, sandbox } = await fixture(t);
  const missing = join(sandbox, "not-created");
  const otherGit = join(sandbox, "another-git"); await fs.mkdir(otherGit);
  await fs.writeFile(join(otherGit, ".git"), "synthetic worktree");
  const alias = join(sandbox, "alias"); await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  for (const path of [missing, projectRoot, sandbox, otherGit, alias, "relative-root"]) {
    await assert.rejects(initializeMediaVolume({ ...config, media: { ...config.media, root: path } }, { projectRoot }), initializationRejected);
  }
  await assert.rejects(fs.lstat(missing), { code: "ENOENT" });
  await fs.writeFile(join(root, "sentinel"), "must remain");
  await assert.rejects(initializeMediaVolume(config, { projectRoot }), initializationRejected);
  assert.deepEqual(await fs.readdir(root), ["sentinel"]);
  assert.equal(await fs.readFile(join(root, "sentinel"), "utf8"), "must remain");
});

test("production and staging require matching marker identity and never adopt another deployment", async t => {
  const { config, projectRoot, marker, media } = await fixture(t, "production");
  await initializeMediaVolume(config, { projectRoot });
  const original = await fs.readFile(marker, "utf8");
  for (const change of [{ environment: "staging" }, { deploymentId: randomUUID() }]) {
    await assert.rejects(initializeMediaVolume({ ...config, ...change }, { projectRoot }), initializationRejected);
    await assert.rejects(createLocalMediaStore({ ...media, ...change }), storageCode("INVALID_CONFIGURATION"));
    assert.equal(await fs.readFile(marker, "utf8"), original);
  }
  for (const identity of [{ ...JSON.parse(original), extra: true }, { ...JSON.parse(original), version: 2 }, {}, null]) {
    await fs.writeFile(marker, JSON.stringify(identity));
    await assert.rejects(createLocalMediaStore(media), storageCode("INVALID_CONFIGURATION"));
  }
});

test("deployment environment selection rejects dev/test fallback and mixed roots", () => {
  const base = { MQ_DEPLOYMENT_ENV: "production", MQ_MEDIA_ENV: "production", MQ_MEDIA_ROOT: "/private/media",
    MQ_MEDIA_DEPLOYMENT_ID: randomUUID(), MQ_MEDIA_MIN_FREE_BYTES: String(reserve) };
  assert.equal(mediaConfigurationFromEnvironment(1024, base).environment, "production");
  for (const change of [{ MQ_DEPLOYMENT_ENV: "test" }, { MQ_DEPLOYMENT_ENV: "" }, { MQ_DEPLOYMENT_ENV: undefined },
    { MQ_MEDIA_ENV: "test" }, { MQ_MEDIA_ENV: "development" }, { MQ_MEDIA_ENV: undefined },
    { MQ_MEDIA_TEST_ROOT: "/test" }, { MQ_MEDIA_DEVELOPMENT_ROOT: "/development" }]) {
    assert.throws(() => mediaConfigurationFromEnvironment(1024, { ...base, ...change }), storageCode("INVALID_CONFIGURATION"));
  }
  for (const environment of ["development", "test"]) {
    assert.equal(mediaConfigurationFromEnvironment(1024, { NODE_ENV: "production", MQ_MEDIA_ENV: environment,
      MQ_MEDIA_DEVELOPMENT_ROOT: "/development", MQ_MEDIA_TEST_ROOT: "/test" }).environment, environment);
  }
  assert.throws(() => mediaConfigurationFromEnvironment(1024, { MQ_MEDIA_ENV: "test", MQ_MEDIA_ROOT: "/private/media" }), storageCode("INVALID_CONFIGURATION"));
});

test("low capacity denies new output but allows existing reads and authorized cleanup", async t => {
  const { config, projectRoot, root, media } = await fixture(t);
  await initializeMediaVolume(config, { projectRoot });
  const store = await createLocalMediaStore(media), key = randomUUID(), next = randomUUID();
  const bytes = Buffer.from("synthetic retained image");
  await store.write(key, "display", bytes);
  const capacity = t.mock.method(fs, "statfs", async () => ({ bavail: 0n, bsize: 4096n }));
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.write(next, "display", bytes), storageCode("LOW_DISK_SPACE"));
    await assert.rejects(fs.lstat(join(root, next)), { code: "ENOENT" });
    const reopened = await createLocalMediaStore(media);
    assert.deepEqual(await reopened.read(key, "display"), bytes);
    await reopened.removeAsset(key);
    assert.deepEqual(await fs.readdir(root), [".mq-deployment.json"]);
  } finally { capacity.mock.restore(); syncBuiltinESMExports(); }
});

test("unavailable statfs fails closed for writes while existing bytes and cleanup remain usable", async t => {
  const { config, projectRoot, root, media } = await fixture(t);
  await initializeMediaVolume(config, { projectRoot });
  const store = await createLocalMediaStore(media), key = randomUUID();
  await store.write(key, "display", Buffer.from("synthetic previous output"));
  const capacity = t.mock.method(fs, "statfs", async () => { throw new Error("synthetic filesystem status failure"); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.write(key, "thumbnail", Buffer.from("new output")), storageCode("STORAGE_UNAVAILABLE"));
    assert.equal((await store.read(key, "display")).toString(), "synthetic previous output");
    await store.removeFailed(key);
    assert.deepEqual(await fs.readdir(root), [".mq-deployment.json"]);
  } finally { capacity.mock.restore(); syncBuiltinESMExports(); }
});

test("write admission includes pending byte length before creating output", async t => {
  const { config, projectRoot, root, media } = await fixture(t);
  await initializeMediaVolume(config, { projectRoot });
  const store = await createLocalMediaStore(media), key = randomUUID(), bytes = Buffer.alloc(17, 1);
  let available = BigInt(reserve + 16);
  const capacity = t.mock.method(fs, "statfs", async () => ({ bavail: available, bsize: 1n }));
  syncBuiltinESMExports();
  try {
    await assert.rejects(store.write(key, "display", bytes), storageCode("LOW_DISK_SPACE"));
    assert.deepEqual(await fs.readdir(root), [".mq-deployment.json"]);
    available++;
    await store.write(key, "display", bytes);
    assert.deepEqual(await store.read(key, "display"), bytes);
  } finally { capacity.mock.restore(); syncBuiltinESMExports(); }
});

test("POSIX deployment volumes require mode0700, UID10001 and a private single-link marker", { skip: process.platform === "win32" }, async t => {
  const { config, projectRoot, root, media, marker, sandbox } = await fixture(t);
  const caller = t.mock.method(process, "geteuid", () => 10002);
  try {
    await assert.rejects(initializeMediaVolume(config, { projectRoot }), initializationRejected);
    assert.deepEqual(await fs.readdir(root), []);
  } finally { caller.mock.restore(); }
  await initializeMediaVolume(config, { projectRoot });
  await fs.chmod(root, 0o755);
  await assert.rejects(createLocalMediaStore(media), storageCode("UNSAFE_PATH"));
  await assert.rejects(initializeMediaVolume(config, { projectRoot }), initializationRejected);
  await fs.chmod(root, 0o700);
  const original = fs.lstat;
  const wrongOwner = t.mock.method(fs, "lstat", async (...args) => {
    const info = await original(...args);
    if (args[0] === root) info.uid = 10002;
    return info;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(createLocalMediaStore(media), storageCode("UNSAFE_PATH"));
    await assert.rejects(initializeMediaVolume(config, { projectRoot }), initializationRejected);
  } finally { wrongOwner.mock.restore(); syncBuiltinESMExports(); }
  await fs.chmod(marker, 0o644);
  await assert.rejects(createLocalMediaStore(media), storageCode("UNSAFE_PATH"));
  await fs.chmod(marker, 0o600);
  await fs.link(marker, join(sandbox, "hardlinked-marker"));
  await assert.rejects(createLocalMediaStore(media), storageCode("UNSAFE_PATH"));
});
