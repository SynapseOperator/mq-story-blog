import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, writeFile, readFile, lstat, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createLocalMediaStore, MediaStorageError } from "../src/server/media/local-store.ts";

async function fixture(t) {
  const sandbox = await mkdtemp(join(tmpdir(), "mq-media-storage-"));
  const projectRoot = join(sandbox, "repository");
  const roots = { development: join(sandbox, "private-development"), test: join(sandbox, "private-test") };
  for (const path of [projectRoot, roots.development, roots.test]) await mkdir(path, { mode: 0o700 });
  await mkdir(join(projectRoot, ".git"));
  // Cleanup is confined to the unique fixture root created by this exact test;
  // the storage API itself never exposes a delete operation.
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const config = { projectRoot, roots, environment: "test", maxVariantBytes: 1024 };
  return { sandbox, config, projectRoot, roots, store: await createLocalMediaStore(config) };
}

function code(expected) {
  return error => error instanceof MediaStorageError && error.code === expected && error.message === expected;
}

test("LOCAL storage round-trips only processed display/thumbnail bytes with no paths or URLs", async t => {
  const { store, roots } = await fixture(t);
  const key = randomUUID();
  const display = Buffer.from("synthetic already-processed display bytes");
  const thumbnail = Buffer.from("synthetic already-processed thumbnail bytes");
  assert.deepEqual(Object.keys(store), ["write", "read"]);
  assert.deepEqual(await store.write(key, "display", display), { byteLength: display.length });
  assert.deepEqual(await store.write(key, "thumbnail", thumbnail), { byteLength: thumbnail.length });
  assert.deepEqual(await store.read(key, "display"), display);
  assert.deepEqual(await store.read(key, "thumbnail"), thumbnail);
  assert.deepEqual((await readdir(join(roots.test, key))).sort(), ["display.webp", "thumbnail.webp"]);
  // Deliberately not valid image data: this test documents that the storage
  // foundation does not impersonate image decoding/MIME validation.
});

test("development and test roots remain independent for the same opaque key", async t => {
  const { config, roots, store } = await fixture(t);
  const development = await createLocalMediaStore({ ...config, environment: "development" });
  const key = randomUUID();
  await store.write(key, "display", Buffer.from("test-only"));
  assert.deepEqual(await readdir(roots.development), []);
  await development.write(key, "display", Buffer.from("development-only"));
  assert.equal((await store.read(key, "display")).toString(), "test-only");
  assert.equal((await development.read(key, "display")).toString(), "development-only");
});

test("configuration rejects relative, missing, overlapping, project/build/public and Git roots", async t => {
  const { config, sandbox, projectRoot, roots } = await fixture(t);
  const invalid = [
    { ...config, roots: { ...roots, test: relative(sandbox, roots.test) } },
    { ...config, roots: { ...roots, test: join(sandbox, "not-created") } },
    { ...config, roots: { ...roots, test: roots.development } },
    { ...config, roots: { ...roots, test: join(roots.development, "nested") } },
    { ...config, roots: { ...roots, test: projectRoot } },
    { ...config, roots: { ...roots, test: join(projectRoot, "public", "media") } },
    { ...config, roots: { ...roots, test: join(projectRoot, ".next", "media") } },
    { ...config, roots: { ...roots, test: sandbox } },
    { ...config, environment: "production" },
    { ...config, maxVariantBytes: Number.POSITIVE_INFINITY },
    { ...config, maxVariantBytes: 0 },
  ];
  for (const value of invalid) await assert.rejects(createLocalMediaStore(value), code("INVALID_CONFIGURATION"));
  const unrelated = join(sandbox, "unrelated-git");
  const privateRoot = join(unrelated, "private");
  await mkdir(unrelated, { mode: 0o700 });
  await writeFile(join(unrelated, ".git"), "synthetic worktree marker");
  await mkdir(privateRoot, { mode: 0o700 });
  await assert.rejects(createLocalMediaStore({ ...config, roots: { ...roots, test: privateRoot } }), code("INVALID_CONFIGURATION"));
});

test("object keys and variants reject traversal and originals before filesystem writes", async t => {
  const { store, roots } = await fixture(t);
  for (const key of ["../private", "..", "", "../../outside", randomUUID() + "/../other", "a".repeat(36), undefined]) {
    await assert.rejects(store.write(key, "display", Buffer.from("safe")), code("INVALID_OBJECT"));
    await assert.rejects(store.read(key, "display"), code("INVALID_OBJECT"));
  }
  for (const variant of ["original", "../original", "__proto__", "display.webp", "", undefined]) {
    await assert.rejects(store.write(randomUUID(), variant, Buffer.from("safe")), code("INVALID_OBJECT"));
  }
  await assert.rejects(store.write(randomUUID(), "display", Buffer.alloc(0)), code("INVALID_OBJECT"));
  await assert.rejects(store.write(randomUUID(), "display", "not bytes"), code("INVALID_OBJECT"));
  assert.deepEqual(await readdir(roots.test), []);
});

test("concurrent immutable publication has one winner, intact bytes and no pending files", async t => {
  const { store, roots } = await fixture(t);
  const key = randomUUID();
  const versions = [Buffer.alloc(1024, 0x31), Buffer.alloc(1024, 0x72)];
  const results = await Promise.allSettled(versions.map(bytes => store.write(key, "display", bytes)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failed = results.find(result => result.status === "rejected");
  assert.ok(code("ALREADY_EXISTS")(failed.reason));
  const winner = results.findIndex(result => result.status === "fulfilled");
  assert.deepEqual(await store.read(key, "display"), versions[winner]);
  await assert.rejects(store.write(key, "display", Buffer.from("replacement")), code("ALREADY_EXISTS"));
  assert.deepEqual(await readdir(join(roots.test, key)), ["display.webp"]);
});

test("failed publication cleans its owned temporary file without deleting existing objects", async t => {
  const { store, roots } = await fixture(t);
  const key = randomUUID();
  const directory = join(roots.test, key);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, "display.webp"), { mode: 0o700 });
  await assert.rejects(store.write(key, "display", Buffer.from("synthetic partial-write probe")), code("ALREADY_EXISTS"));
  assert.deepEqual(await readdir(directory), ["display.webp"]);
  assert.equal((await lstat(join(directory, "display.webp"))).isDirectory(), true);
  await assert.rejects(store.read(key, "display"), code("UNSAFE_PATH"));
});

test("reads are bounded and missing objects expose only a fixed error code", async t => {
  const { store, roots } = await fixture(t);
  const key = randomUUID();
  await assert.rejects(store.read(key, "display"), code("NOT_FOUND"));
  await assert.rejects(store.write(key, "display", Buffer.alloc(1025)), code("TOO_LARGE"));
  assert.deepEqual(await readdir(roots.test), []);
  await mkdir(join(roots.test, key), { mode: 0o700 });
  await writeFile(join(roots.test, key, "display.webp"), Buffer.alloc(1025), { mode: 0o600 });
  await assert.rejects(store.read(key, "display"), code("TOO_LARGE"));
});

test("root and ancestor junctions/symlinks are refused", async t => {
  const { config, sandbox, roots } = await fixture(t);
  const target = join(sandbox, "redirect-target");
  await mkdir(target, { mode: 0o700 });
  await mkdir(join(target, "nested"), { mode: 0o700 });
  const redirected = join(sandbox, "redirected");
  await symlink(target, redirected, process.platform === "win32" ? "junction" : "dir");
  for (const path of [redirected, join(redirected, "nested")]) {
    await assert.rejects(createLocalMediaStore({ ...config, roots: { ...roots, test: path } }), code("UNSAFE_PATH"));
  }
  assert.deepEqual(await readdir(target), ["nested"]);
});

test("object-directory junctions/symlinks cannot escape the private root", async t => {
  const { store, sandbox, roots } = await fixture(t);
  const outside = join(sandbox, "outside-object");
  await mkdir(outside, { mode: 0o700 });
  const key = randomUUID();
  await symlink(outside, join(roots.test, key), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.write(key, "display", Buffer.from("must not escape")), code("UNSAFE_PATH"));
  await assert.rejects(store.read(key, "display"), code("UNSAFE_PATH"));
  assert.deepEqual(await readdir(outside), []);
});

test("file symlinks cannot return another file's bytes", async t => {
  const { store, sandbox, roots } = await fixture(t);
  const target = join(sandbox, "outside-file");
  await writeFile(target, "outside synthetic bytes", { mode: 0o600 });
  const key = randomUUID();
  await mkdir(join(roots.test, key), { mode: 0o700 });
  try { await symlink(target, join(roots.test, key, "display.webp"), "file"); }
  catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.skip("Windows file-symlink privilege unavailable; directory junction cases run separately"); return;
    }
    throw error;
  }
  await assert.rejects(store.read(key, "display"), code("UNSAFE_PATH"));
  await assert.rejects(store.write(key, "display", Buffer.from("replacement")), code("ALREADY_EXISTS"));
  assert.equal(await readFile(target, "utf8"), "outside synthetic bytes");
});

test("POSIX roots and objects enforce 0700/0600 private modes", { skip: process.platform === "win32" }, async t => {
  const { store, config, roots } = await fixture(t);
  const key = randomUUID();
  await store.write(key, "display", Buffer.from("synthetic mode probe"));
  assert.equal((await lstat(roots.test)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(roots.test, key))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(roots.test, key, "display.webp"))).mode & 0o777, 0o600);
  await chmod(join(roots.test, key, "display.webp"), 0o644);
  await assert.rejects(store.read(key, "display"), code("UNSAFE_PATH"));
  await chmod(roots.test, 0o755);
  await assert.rejects(createLocalMediaStore(config), code("UNSAFE_PATH"));
});
