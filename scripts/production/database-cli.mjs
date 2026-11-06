import { pathToFileURL } from "node:url";
import pg from "pg";
import { readDeploymentFile, readDeploymentManifest } from "./runtime-config.mjs";
import { assertDatabaseUrl } from "./database-config.mjs";
import { bootstrapDeploymentDatabase, migrateDeploymentDatabase, provisionDeploymentDatabase,
  initializeDeploymentSigningKeys, auditRuntimeDatabase } from "./database.mjs";

/** Every target and credential comes from an explicitly named external file.
 * Production writes additionally require this deployment's public identifier
 * in argv. No credential or SQL detail is included in diagnostics. */
export async function runDatabaseCommand(args, env = process.env) {
  let pool;
  let poolFailed = false;
  try {
    const [operation, confirmation, ...extra] = args;
    if (!["bootstrap", "migrate", "provision", "keys", "audit"].includes(operation) || extra.length) {
      throw new Error("DEPLOYMENT_DATABASE_COMMAND_REJECTED");
    }
    const config = await readDeploymentManifest(env.MQ_DEPLOYMENT_CONFIG);
    const needsConfirmation = config.environment === "production" && operation !== "audit";
    if (needsConfirmation ? confirmation !== `--confirm-production=${config.deploymentId}` : confirmation !== undefined) {
      throw new Error("DEPLOYMENT_DATABASE_CONFIRMATION_REQUIRED");
    }
    const identity = operation === "audit" ? "runtime" : operation === "migrate" ? "migration" : "bootstrap";
    const readSecret = async name => (await readDeploymentFile(env[name], { secret: true })).replace(/\r?\n$/, "");
    const connectionString = await readSecret(`${identity.toUpperCase()}_DATABASE_URL_FILE`);
    assertDatabaseUrl(connectionString, config, identity);
    let result;
    if (operation === "migrate") result = await migrateDeploymentDatabase(connectionString, config);
    else {
      pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
      pool.on("error", () => { poolFailed = true; });
      if (operation === "bootstrap") {
        result = await bootstrapDeploymentDatabase(pool, config, JSON.parse(await readSecret("MQ_ROLE_PASSWORDS_FILE")));
      } else if (operation === "provision") result = await provisionDeploymentDatabase(pool, config);
      else if (operation === "keys") result = await initializeDeploymentSigningKeys(pool, config, {
        publication: await readSecret("MQ_PUBLISH_SIGNING_KEY_FILE"), moderation: await readSecret("MQ_COMMENT_SIGNING_KEY_FILE"),
      });
      else result = await auditRuntimeDatabase(pool, config);
    }
    if (pool) await pool.end();
    if (poolFailed) throw new Error("DEPLOYMENT_DATABASE_CONNECTION_REJECTED");
    console.log(JSON.stringify({ operation, ...result }));
    return 0;
  } catch {
    console.error("DEPLOYMENT_DATABASE_COMMAND_REJECTED (check external files, target, identity and production confirmation; details withheld)");
    return 1;
  } finally { if (pool && !pool.ending) await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runDatabaseCommand(process.argv.slice(2));
}
