import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { URL } from "node:url";

const environmentFile = new URL("../../.env.db.local", import.meta.url);

export async function readLocalEnvironment() {
  try { return parseEnv(await readFile(environmentFile, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Cannot read the local database environment file", { cause: error });
  }
}

/** Local foundation only. Never let a test silently default to the dev DB. */
export function validateDatabaseUrl(value, target) {
  if (!["dev", "test"].includes(target)) throw new Error("Unknown database target");
  if (!value) throw new Error(`Missing ${target} database URL; run db:env or set its environment variable`);
  let url;
  try { url = new URL(value); }
  catch { throw new Error("Invalid database URL (value omitted)"); }
  const expected = target === "dev"
    ? { database: "/mq_development", user: "mq_dev" }
    : { database: "/mq_test", user: "mq_test" };
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.pathname !== expected.database || url.username !== expected.user
    || !url.port || url.search || url.hash) {
    throw new Error(`Refusing an unexpected ${target} database target (URL omitted)`);
  }
  if (!url.password && !(target === "test" && process.env.CI === "true")) {
    throw new Error("Local databases require a generated password; only isolated CI test services may omit one");
  }
  return url;
}

export async function databaseUrl(target, { localOnly = false } = {}) {
  const key = target === "dev" ? "DEV_DATABASE_URL" : "TEST_DATABASE_URL";
  const local = await readLocalEnvironment();
  return validateDatabaseUrl((!localOnly && process.env[key]) || local[key], target).href;
}
