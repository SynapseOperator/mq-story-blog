import assert from "node:assert/strict";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin, revokeAdmin, restoreAdmin, resetAdminPassword, AdminMaintenanceError } from "../../src/server/admin/maintenance.ts";
import { parseMaintenanceArguments, verifyMaintenanceConnection } from "../admin/maintenance-policy.mjs";
import { readHiddenPassword } from "../admin/terminal.mjs";
import { readDeploymentFile, readDeploymentManifest } from "./runtime-config.mjs";
import { assertDatabaseUrl, deploymentDatabaseTag } from "./database-config.mjs";
import { auditPrivileges } from "./database.mjs";
import { verifyDatabaseLogging } from "../db/log-privacy.mjs";

/** The local development CLI remains local-only. This entrypoint consumes the
 * deployment's file credentials and exact derived maintenance identity. */
export function parseDeploymentAdminArguments(args, config) {
  const confirmation = args.filter(value => value.startsWith("--confirm-production="));
  const rest = args.filter(value => !value.startsWith("--confirm-production="));
  const status = rest.length === 2 && rest[0] === "--operation" && rest[1] === "status";
  const needsConfirmation = config.environment === "production" && !status;
  assert.deepEqual(confirmation, needsConfirmation ? [`--confirm-production=${config.deploymentId}`] : [],
    "ADMIN_DEPLOYMENT_CONFIRMATION_REQUIRED");
  if (status) return { database: config.database.name, operation: "status" };
  return parseMaintenanceArguments(["--database", config.database.name, ...rest]);
}

export async function verifyDeploymentAdminConnection(pool, config) {
  const context = (await pool.query(`SELECT current_database() AS database,current_user AS actor,session_user AS login,
    current_setting('server_version_num')::int AS version,shobj_description(oid,'pg_database') AS tag
    FROM pg_database WHERE datname=current_database()`)).rows[0];
  assert.equal(context.database, config.database.name, "ADMIN_DEPLOYMENT_TARGET_REJECTED");
  assert.equal(context.actor, config.roles.maintenance, "ADMIN_DEPLOYMENT_IDENTITY_REJECTED");
  assert.equal(context.login, context.actor, "ADMIN_DEPLOYMENT_IDENTITY_REJECTED");
  assert.ok(context.version >= 180000 && context.version < 190000, "ADMIN_DEPLOYMENT_TARGET_REJECTED");
  assert.equal(context.tag, deploymentDatabaseTag(config), "ADMIN_DEPLOYMENT_TARGET_REJECTED");
  await verifyDatabaseLogging(pool);
  await verifyMaintenanceConnection(pool, config.database.name);
  await auditPrivileges(pool, config);
}

/** Shared execution path for the terminal and isolated synthetic tests. No
 * HTTP endpoint calls it. Domain transactions and native audit triggers remain
 * the sole authority for grant changes and session invalidation. */
export async function executeDeploymentAdminOperation({ pool, db, config, input, password }) {
  await verifyDeploymentAdminConnection(pool, config);
  if (input.operation === "status") {
    const rows = (await pool.query('SELECT "userId",version,"revokedAt" IS NOT NULL AS revoked FROM public."AdminGrant" WHERE id=1')).rows;
    return rows.length ? { initialized: true, ...rows[0] } : { initialized: false };
  }
  if (input.operation === "init") return initializeAdmin(db, { username: input.username, password });
  const target = { userId: input.userId, expectedVersion: input.expectedVersion };
  if (input.operation === "revoke") return revokeAdmin(db, target);
  if (input.operation === "restore") return restoreAdmin(db, target);
  assert.equal(input.operation, "reset-password", "ADMIN_DEPLOYMENT_OPERATION_REJECTED");
  return resetAdminPassword(db, { ...target, password });
}

async function confirmOperation(input, config) {
  const phrase = `${input.operation.toUpperCase()} ${config.deploymentId} ${input.operation === "init" ? input.username : input.userId}`;
  console.log(`Deployment=${config.deploymentId}; environment=${config.environment}; database=${config.database.name}; operation=${input.operation}`);
  console.log("Revoke, restore and password reset invalidate all sessions. This does not enable public registration or publishing.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new globalThis.AbortController(), cancel = () => controller.abort();
  terminal.once("SIGINT", cancel);
  try { assert.equal(await terminal.question(`Type exactly: ${phrase}\n> `, { signal: controller.signal }), phrase, "ADMIN_DEPLOYMENT_CONFIRMATION_REQUIRED"); }
  finally { terminal.off("SIGINT", cancel); terminal.close(); }
}

export async function runDeploymentAdminCommand(args, env = process.env) {
  let pool, db, failed = false;
  try {
    // No raw credential, password file, fixture, or piped password mode exists.
    for (const name of ["MQ_ADMIN_PASSWORD", "ADMIN_PASSWORD", "MQ_ADMIN_MAINTENANCE_DATABASE_URL", "MAINTENANCE_DATABASE_URL", "MQ_LAB_ACCOUNTS_FILE"])
      assert.equal(Object.hasOwn(env, name), false, "ADMIN_DEPLOYMENT_INLINE_SECRET_REJECTED");
    const config = await readDeploymentManifest(env.MQ_DEPLOYMENT_CONFIG);
    assert.equal(env.MQ_DEPLOYMENT_ENV, config.environment, "ADMIN_DEPLOYMENT_TARGET_REJECTED");
    const input = parseDeploymentAdminArguments(args, config);
    if (input.operation !== "status") assert.ok(process.stdin.isTTY && process.stdout.isTTY, "ADMIN_DEPLOYMENT_TTY_REQUIRED");
    const url = (await readDeploymentFile(env.MAINTENANCE_DATABASE_URL_FILE, { secret: true })).replace(/\r?\n$/, "");
    assertDatabaseUrl(url, config, "maintenance");
    pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000 });
    pool.on("error", () => { failed = true; });
    let password;
    if (input.operation !== "status") {
      await verifyDeploymentAdminConnection(pool, config);
      await confirmOperation(input, config);
      if (["init", "reset-password"].includes(input.operation)) {
        password = await readHiddenPassword("New password (hidden, 12–128 characters): ");
        assert.equal(await readHiddenPassword("Repeat new password (hidden): "), password, "ADMIN_DEPLOYMENT_PASSWORD_CONFIRMATION_FAILED");
      }
      db = createAuthDatabaseClient(url);
    }
    assert.equal(failed, false, "ADMIN_DEPLOYMENT_CONNECTION_FAILED");
    const result = await executeDeploymentAdminOperation({ pool, db, config, input, password });
    await db?.$disconnect(); db = undefined;
    await pool.end(); pool = undefined;
    assert.equal(failed, false, "ADMIN_DEPLOYMENT_CONNECTION_FAILED");
    console.log(JSON.stringify({ operation: input.operation, deploymentId: config.deploymentId, ...result }));
    return 0;
  } catch (error) {
    // Never serialize driver errors, SQL, password input, Cookie or the URL.
    const code = error instanceof AdminMaintenanceError ? error.code : "REJECTED";
    console.error(`ADMIN_DEPLOYMENT_${code}; connection and password details withheld`);
    return 1;
  } finally {
    // Cleanup errors do not turn an already failed command into an unhandled
    // Prisma/pg object dump. The successful path closes before reporting success.
    await Promise.allSettled([db?.$disconnect(), pool && !pool.ending ? pool.end() : undefined]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runDeploymentAdminCommand(process.argv.slice(2));
