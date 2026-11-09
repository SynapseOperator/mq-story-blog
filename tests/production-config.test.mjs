import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { loadRuntimeEnvironment, readDeploymentFile, readDeploymentManifest, RUNTIME_SECRET_NAMES } from "../scripts/production/runtime-config.mjs";
import { validateDeploymentConfig } from "../scripts/production/database-config.mjs";

const rejected = /^Error: DEPLOYMENT_RUNTIME_CONFIG_REJECTED$/;

async function fixture(t, environment = "staging") {
  const sandbox = await fs.mkdtemp(join(tmpdir(), "mq-production-config-"));
  const projectRoot = join(sandbox, "repository"), root = join(sandbox, "media");
  await fs.mkdir(projectRoot, { mode: 0o700 });
  await fs.mkdir(join(projectRoot, ".git"));
  await fs.mkdir(root, { mode: 0o700 });
  const manifest = { version: 1, environment, deploymentId: randomUUID(),
    database: { host: "database", port: 5432, name: `mq_${environment}` },
    origin: "https://synthetic.example.invalid", media: { root, minFreeBytes: 256 * 1024 * 1024 } };
  const marker = join(root, ".mq-deployment.json");
  await fs.writeFile(marker, JSON.stringify({ version: 1, environment, deploymentId: manifest.deploymentId }), { mode: 0o600 });
  // Portable unit fixtures inject only the dedicated service UID metadata when
  // the developer/CI user differs. Linux container acceptance checks real UID.
  if (process.platform !== "win32" && process.geteuid() !== 10001) {
    const original = fs.lstat;
    const owner = t.mock.method(fs, "lstat", async (...args) => {
      const info = await original(...args);
      if ([root, marker].includes(args[0])) info.uid = 10001;
      return info;
    });
    syncBuiltinESMExports();
    t.after(() => { owner.mock.restore(); syncBuiltinESMExports(); });
  }
  const configPath = join(sandbox, "deployment.json");
  await fs.writeFile(configPath, JSON.stringify(manifest), { mode: 0o444 });
  const config = validateDeploymentConfig(manifest);
  const values = Object.fromEntries(RUNTIME_SECRET_NAMES.map(name => [name, randomBytes(32).toString("hex")]));
  values.DATABASE_URL = `postgresql://${config.roles.runtime}:${randomBytes(32).toString("hex")}@database:5432/${manifest.database.name}`;
  const input = { NODE_ENV: "production", MQ_DEPLOYMENT_ENV: environment, MQ_DEPLOYMENT_CONFIG: configPath };
  for (const name of RUNTIME_SECRET_NAMES) {
    input[`${name}_FILE`] = join(sandbox, name.toLowerCase());
    await fs.writeFile(input[`${name}_FILE`], values[name] + "\n", { mode: 0o600 });
  }
  t.after(async () => {
    await fs.chmod(configPath, 0o600);
    await fs.rm(sandbox, { recursive: true, force: true });
  });
  return { sandbox, projectRoot, root, manifest, config, configPath, input, values,
    load: inputValue => loadRuntimeEnvironment(inputValue ?? input, { projectRoot }),
    saveManifest: async value => {
      await fs.chmod(configPath, 0o600);
      await fs.writeFile(configPath, JSON.stringify(value));
      await fs.chmod(configPath, 0o444);
    } };
}

test("deployment startup reads six file-only secrets and derives an isolated runtime environment", async t => {
  const { input, load, config, values, root, projectRoot } = await fixture(t);
  const result = await load({ ...input, MQ_AUTH_ENABLED: "true", MQ_MEDIA_ENABLED: "true", PATH: process.env.PATH,
    NODE_OPTIONS: "--inspect", MQ_ADMIN_MAINTENANCE_DATABASE_URL: "synthetic-discarded", UNKNOWN_FILE: "discarded" });
  assert.deepEqual(Object.keys(result).sort(), ["config", "env", "media"]);
  assert.equal(result.config.roles.runtime, config.roles.runtime);
  assert.equal(result.env.AUTH_ORIGIN, config.origin);
  assert.equal(result.env.AUTH_ALLOW_LOCAL_HTTP, "false");
  assert.equal(result.env.MQ_MEDIA_ENV, "staging");
  assert.equal(result.env.MQ_MEDIA_ROOT, root);
  assert.equal(result.env.MQ_PUBLISH_ENABLED, "false");
  assert.equal(result.env.MQ_COMMENTS_ENABLED, "false");
  assert.equal(result.env.MQ_AUTH_ENABLED, "true");
  assert.equal(result.env.PATH, process.env.PATH);
  for (const name of RUNTIME_SECRET_NAMES) {
    assert.equal(result.env[name], values[name]);
    assert.equal(Object.hasOwn(result.env, `${name}_FILE`), false);
  }
  for (const name of ["NODE_OPTIONS", "MQ_ADMIN_MAINTENANCE_DATABASE_URL", "UNKNOWN_FILE", "MQ_DEPLOYMENT_CONFIG"]) {
    assert.equal(Object.hasOwn(result.env, name), false);
  }
  assert.deepEqual(result.media, { projectRoot, root, environment: "staging", deploymentId: config.deploymentId,
    maxVariantBytes: 4 * 1024 * 1024, minimumFreeBytes: 256 * 1024 * 1024 });
});

test("production uses its own derived runtime role and volume identity", async t => {
  const { load, config } = await fixture(t, "production");
  const result = await load();
  assert.equal(result.env.MQ_DEPLOYMENT_ENV, "production");
  assert.equal(new URL(result.env.DATABASE_URL).username, config.roles.runtime);
  assert.match(config.roles.runtime, /^mq_production_[a-f0-9]{8}_runtime$/);
});

test("startup rejects raw/file mixtures, secret aliases, mode mismatches and manifest overrides", async t => {
  const { load, input } = await fixture(t);
  for (const name of [...RUNTIME_SECRET_NAMES, "BETTER_AUTH_SECRET", "BETTER_AUTH_SECRETS", "MQ_AUTH_SECRET",
    "BETTER_AUTH_SECRET_FILE", "BETTER_AUTH_SECRETS_FILE", "MQ_AUTH_SECRET_FILE", "BETTER_AUTH_URL", "BETTER_AUTH_URL_FILE",
    "MQ_MEDIA_ROOT", "MQ_MEDIA_DEPLOYMENT_ID", "MQ_MEDIA_MIN_FREE_BYTES", "MQ_MEDIA_DEVELOPMENT_ROOT", "MQ_MEDIA_TEST_ROOT"]) {
    await assert.rejects(load({ ...input, [name]: "" }), rejected, name);
  }
  for (const change of [{ NODE_ENV: "development" }, { MQ_DEPLOYMENT_ENV: "test" }, { MQ_DEPLOYMENT_ENV: "production" },
    { AUTH_ALLOW_LOCAL_HTTP: "true" }, { AUTH_ALLOW_LOCAL_HTTP: "FALSE" }, { AUTH_ORIGIN: "https://other.invalid" },
    { AUTH_ORIGIN: "" }, { MQ_MEDIA_ENV: "test" }, { MQ_MEDIA_ENV: "" }, { MQ_AUTH_ENABLED: "1" },
    { MQ_MEDIA_ENABLED: "TRUE" }, { MQ_PUBLISH_ENABLED: "yes" }, { MQ_COMMENTS_ENABLED: "" }]) {
    await assert.rejects(load({ ...input, ...change }), rejected);
  }
  for (const name of RUNTIME_SECRET_NAMES) {
    const missing = { ...input }; delete missing[`${name}_FILE`];
    await assert.rejects(load(missing), rejected, name);
  }
});

test("database secret must match the exact manifest host, port, database and derived runtime login", async t => {
  const { load, input, config, values } = await fixture(t);
  const valid = new URL(values.DATABASE_URL);
  for (const change of [{ hostname: "another-database" }, { port: "5433" }, { pathname: "/mq_test" },
    { pathname: "/mq_production" }, { username: config.roles.migration }, { username: config.roles.backup },
    { username: "postgres" }, { password: "" }, { search: "?schema=public" }, { hash: "#target" }]) {
    const value = new URL(valid); Object.assign(value, change);
    await fs.writeFile(input.DATABASE_URL_FILE, value.href);
    await assert.rejects(load(), rejected);
  }
});

test("secrets reject invalid UTF-8, multiline values, whitespace, short keys and reuse", async t => {
  const { load, input, values } = await fixture(t);
  for (const value of ["", "a".repeat(63), "A".repeat(64), ` ${values.AUTH_SECRET}`, `${values.AUTH_SECRET} `,
    `${values.AUTH_SECRET}\n\n`, `${values.AUTH_SECRET}\0`, Buffer.from([0xc3, 0x28]), values.AUTH_PROXY_SECRET,
    new URL(values.DATABASE_URL).password]) {
    await fs.writeFile(input.AUTH_SECRET_FILE, value);
    await assert.rejects(load(), rejected);
  }
  await fs.writeFile(input.AUTH_SECRET_FILE, `${values.AUTH_SECRET}\r\n`);
  assert.equal((await load()).env.AUTH_SECRET, values.AUTH_SECRET);
});

test("session storage requires its own file secret even while business is disabled", async t => {
  const { load, input, values } = await fixture(t);
  const missing = { ...input }; delete missing.SESSION_STORAGE_KEY_FILE;
  await assert.rejects(load(missing), rejected);
  await assert.rejects(load({ ...input, SESSION_STORAGE_KEY: values.SESSION_STORAGE_KEY }), rejected);
  for (const value of ["", "a".repeat(63), "A".repeat(64), values.AUTH_SECRET, values.AUTH_PROXY_SECRET,
    values.MQ_PUBLISH_SIGNING_KEY, values.MQ_COMMENT_SIGNING_KEY, new URL(values.DATABASE_URL).password]) {
    await fs.writeFile(input.SESSION_STORAGE_KEY_FILE, value);
    await assert.rejects(load(), rejected);
  }
  await fs.writeFile(input.SESSION_STORAGE_KEY_FILE, values.SESSION_STORAGE_KEY);
  assert.ok((await load()).env.SESSION_STORAGE_KEY === values.SESSION_STORAGE_KEY);
});

test("manifest schema rejects credentials, insecure origins, arbitrary roles and invalid reserve", async t => {
  const { projectRoot, configPath, manifest, saveManifest } = await fixture(t);
  for (const value of [{ ...manifest, DATABASE_URL: "synthetic" }, { ...manifest, roles: {} },
    { ...manifest, version: 2 }, { ...manifest, environment: "test" }, { ...manifest, deploymentId: "invalid" },
    ...["http://synthetic.invalid", "https://synthetic.invalid/path", "https://synthetic.invalid/", "https://name:password@synthetic.invalid"].map(origin => ({ ...manifest, origin })),
    { ...manifest, database: { ...manifest.database, user: "postgres" } },
    { ...manifest, media: { ...manifest.media, root: "relative-media" } },
    { ...manifest, media: { ...manifest.media, minFreeBytes: 0 } },
    { ...manifest, media: { ...manifest.media, minFreeBytes: 16 * 1024 * 1024 * 1024 + 1 } }]) {
    await saveManifest(value);
    await assert.rejects(readDeploymentManifest(configPath, { projectRoot }), rejected);
  }
});

test("configuration files stay outside every Git checkout and reject directories, hard links and oversized files", async t => {
  const { sandbox, projectRoot, input, load } = await fixture(t);
  const other = join(sandbox, "another-checkout");
  await fs.mkdir(other); await fs.writeFile(join(other, ".git"), "synthetic worktree");
  const tracked = join(projectRoot, "secret"), otherTracked = join(other, "secret");
  await fs.writeFile(tracked, "a".repeat(64)); await fs.writeFile(otherTracked, "a".repeat(64));
  const oversized = join(sandbox, "oversized"); await fs.writeFile(oversized, "a".repeat(4097));
  for (const path of ["relative-file", sandbox, tracked, otherTracked, oversized, join(sandbox, "missing")]) {
    await assert.rejects(load({ ...input, AUTH_SECRET_FILE: path }), rejected);
  }
  const linked = join(sandbox, "linked"); await fs.link(input.AUTH_SECRET_FILE, linked);
  await assert.rejects(load({ ...input, AUTH_SECRET_FILE: linked }), rejected);
});

test("configuration rejects ancestor junctions/symlinks without following them", async t => {
  const { sandbox, projectRoot } = await fixture(t);
  const target = join(sandbox, "target"); await fs.mkdir(target);
  await fs.writeFile(join(target, "secret"), "a".repeat(64), { mode: 0o600 });
  const alias = join(sandbox, "alias");
  await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readDeploymentFile(join(alias, "secret"), { projectRoot, secret: true }), rejected);
});

test("startup fails closed when the deployment volume is full or statfs is unavailable", async t => {
  const { load } = await fixture(t);
  const capacity = t.mock.method(fs, "statfs", async () => ({ bavail: 0n, bsize: 4096n }));
  syncBuiltinESMExports();
  try {
    await assert.rejects(load(), rejected);
    capacity.mock.mockImplementation(async () => { throw new Error("synthetic status failure"); });
    await assert.rejects(load(), rejected);
  } finally { capacity.mock.restore(); syncBuiltinESMExports(); }
});

test("POSIX secrets accept only 0400/0600 and nonsecret manifests have no write bits", { skip: process.platform === "win32" }, async t => {
  const { projectRoot, input, configPath } = await fixture(t);
  for (const file of [input.AUTH_SECRET_FILE, input.SESSION_STORAGE_KEY_FILE]) {
    for (const mode of [0o400, 0o600]) {
      await fs.chmod(file, mode);
      assert.ok(await readDeploymentFile(file, { projectRoot, secret: true }));
    }
    for (const mode of [0o644, 0o440, 0o700, 0o200, 0o4600]) {
      await fs.chmod(file, mode);
      await assert.rejects(readDeploymentFile(file, { projectRoot, secret: true }), rejected);
    }
    await fs.chmod(file, 0o600);
  }
  for (const mode of [0o400, 0o444]) {
    await fs.chmod(configPath, mode);
    assert.ok(await readDeploymentManifest(configPath, { projectRoot }));
  }
  for (const mode of [0o600, 0o644, 0o664, 0o777]) {
    await fs.chmod(configPath, mode);
    await assert.rejects(readDeploymentManifest(configPath, { projectRoot }), rejected);
  }
});
