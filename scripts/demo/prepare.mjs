import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, chown, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "../production/database-config.mjs";
import { validateDemoState, demoOrigin } from "./config.mjs";

try {
  const state = validateDemoState({ version: 1, deploymentId: process.env.MQ_DEMO_ID, port: Number(process.env.MQ_DEMO_PORT) });
  const config = validateDeploymentConfig({ version: 1, environment: "staging", deploymentId: state.deploymentId,
    database: { host: "postgres", port: 5432, name: `mq_staging_${state.deploymentId.replaceAll("-", "")}` } });
  const locations = ["/run/mq-demo/runtime", "/run/mq-demo/setup", "/run/mq-demo/postgres"];
  const existing = await Promise.all(locations.map(path => readdir(path)));
  if (existing.some(entries => entries.length)) {
    const previous = JSON.parse(await readFile("/run/mq-demo/setup/config.json", "utf8"));
    assert.deepEqual(previous, { ...state, database: config.database });
    assert.ok(existing[0].includes("runtime.json") && existing[1].includes("credentials.json") && existing[2].includes("password"));
    console.log("DEMO_SECRET_VOLUMES_REUSED");
  } else {
    const random = () => randomBytes(32).toString("hex");
    const postgres = random(), rolePasswords = Object.fromEntries(LOGIN_IDENTITIES.map(key => [key, random()]));
    const url = (role, password) => `postgresql://${role}:${password}@postgres:5432/${config.database.name}`;
    const runtime = { DATABASE_URL: url(config.roles.runtime, rolePasswords.runtime), AUTH_SECRET: random(),
      SESSION_STORAGE_KEY: random(), MQ_PUBLISH_SIGNING_KEY: random(), MQ_COMMENT_SIGNING_KEY: random() };
    const credentials = { bootstrap: url("mq_bootstrap", postgres), rolePasswords,
      migration: url(config.roles.migration, rolePasswords.migration), maintenance: url(config.roles.maintenance, rolePasswords.maintenance),
      runtime, admin: { username: "demo_admin", password: random() }, reader: { username: "demo_reader", password: random() } };
    const files = [[`${locations[0]}/runtime.json`, { ...runtime, origin: demoOrigin(state), database: config.database,
      deploymentId: state.deploymentId }], [`${locations[1]}/credentials.json`, credentials],
      [`${locations[1]}/config.json`, { ...state, database: config.database }], [`${locations[2]}/password`, postgres]];
    for (const [path, value] of files) {
      await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { flag: "wx", mode: 0o400 });
      await chown(path, path.endsWith("/password") ? 999 : 10001, path.endsWith("/password") ? 999 : 10001);
    }
    for (const path of locations) { await chmod(path, 0o700); await chown(path, path.endsWith("postgres") ? 999 : 10001, path.endsWith("postgres") ? 999 : 10001); }
    console.log("DEMO_SECRET_VOLUMES_CREATED");
  }
  for (const path of ["/var/lib/mq-demo/development", "/var/lib/mq-demo/test"]) {
    await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); await chown(path, 10001, 10001);
  }
} catch { console.error("DEMO_PREPARE_FAILED: existing files are retained; no automatic reset"); process.exitCode = 1; }
