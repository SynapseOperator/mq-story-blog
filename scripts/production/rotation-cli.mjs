import { pathToFileURL } from "node:url";
import pg from "pg";
import { readDeploymentFile, readDeploymentManifest } from "./runtime-config.mjs";
import { assertDatabaseUrl } from "./database-config.mjs";
import { pauseDeploymentWriters, resumeDeploymentWriters, rotateDeploymentPasswords,
  revokeDeploymentSessions, rotateDeploymentSigningKeys } from "./rotation.mjs";

export async function runRotationCommand(args, env = process.env) {
  let pool, failed = false;
  try {
    const [operation, confirmation, ...extra] = args;
    if (!["pause", "resume", "database", "signing", "revoke-sessions"].includes(operation) || extra.length) throw new Error();
    const config = await readDeploymentManifest(env.MQ_DEPLOYMENT_CONFIG);
    if (env.MQ_DEPLOYMENT_ENV !== config.environment) throw new Error();
    if (confirmation !== `--confirm-deployment=${config.deploymentId}`) throw new Error();
    const read = async name => (await readDeploymentFile(env[name], { secret: true })).replace(/\r?\n$/, "");
    const connectionString = await read("BOOTSTRAP_DATABASE_URL_FILE");
    assertDatabaseUrl(connectionString, config, "bootstrap");
    pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
    pool.on("error", () => { failed = true; });
    let result;
    if (operation === "pause") result = await pauseDeploymentWriters(pool, config);
    if (operation === "resume") result = await resumeDeploymentWriters(pool, config);
    if (operation === "revoke-sessions") result = await revokeDeploymentSessions(pool, config);
    if (operation === "database") result = await rotateDeploymentPasswords(pool, config, JSON.parse(await read("MQ_NEW_ROLE_PASSWORDS_FILE")));
    if (operation === "signing") result = await rotateDeploymentSigningKeys(pool, config, {
      previousPublication: await read("MQ_PREVIOUS_PUBLISH_SIGNING_KEY_FILE"),
      previousModeration: await read("MQ_PREVIOUS_COMMENT_SIGNING_KEY_FILE"),
      publication: await read("MQ_NEW_PUBLISH_SIGNING_KEY_FILE"),
      moderation: await read("MQ_NEW_COMMENT_SIGNING_KEY_FILE"),
    });
    await pool.end();
    if (failed) throw new Error();
    console.log(JSON.stringify({ operation, deploymentId: config.deploymentId, at: new Date().toISOString(), ...result }));
    return 0;
  } catch {
    console.error("DEPLOYMENT_ROTATION_REJECTED (verify target, file permissions, confirmation and stopped writers; no automatic resume)");
    return 1;
  } finally { if (pool && !pool.ending) await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runRotationCommand(process.argv.slice(2));
}
