import { createInterface } from "node:readline/promises";
import pg from "pg";
import { createDatabaseClient } from "../../src/lib/db/client.ts";
import { initializeAdmin, revokeAdmin, restoreAdmin, resetAdminPassword, AdminMaintenanceError } from "../../src/server/admin/maintenance.ts";
import { parseMaintenanceArguments, validateMaintenanceTarget, maintenanceConfirmation, verifyMaintenanceConnection } from "./maintenance-policy.mjs";
import { readHiddenPassword } from "./terminal.mjs";

// This command intentionally does not load .env.db.local, accept a URL/password
// in argv, read a password from env/stdin pipes, or connect through the app role.
async function confirmTarget(input, role, endpoint) {
  const phrase = maintenanceConfirmation(input);
  console.log(`Local maintenance target: ${endpoint}; database=${input.database}; role=${role}; operation=${input.operation}`);
  console.log("Administrator authorization is shared by account; database-role audit cannot identify the individual operator.");
  console.log("Revoke, restore and password reset invalidate all existing sessions. No account transfer or second administrator is supported.");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new globalThis.AbortController();
  const cancel = () => controller.abort();
  reader.once("SIGINT", cancel);
  try {
    const answer = await reader.question(`Type exactly: ${phrase}\n> `, { signal: controller.signal });
    if (answer !== phrase) throw new Error("CONFIRMATION_FAILED");
  } finally { reader.off("SIGINT", cancel); reader.close(); }
}

async function main() {
  const input = parseMaintenanceArguments(process.argv.slice(2));
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("TTY_REQUIRED");
  if (process.env.MQ_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD) throw new Error("PASSWORD_ENV_REFUSED");
  const target = validateMaintenanceTarget(process.env.MQ_ADMIN_MAINTENANCE_DATABASE_URL, input.database);
  const pool = new pg.Pool({ connectionString: target.href, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
  let connectionFailed = false;
  pool.on("error", () => { connectionFailed = true; });
  let db;
  let password = "";
  let result;
  let cleanupFailed;
  try {
    const role = await verifyMaintenanceConnection(pool, input.database);
    await confirmTarget(input, role, `${target.hostname}:${target.port}`);
    if (input.operation === "init" || input.operation === "reset-password") {
      password = await readHiddenPassword("New password (hidden, 12–128 characters): ");
      const repeated = await readHiddenPassword("Repeat new password (hidden): ");
      if (password !== repeated) throw new Error("PASSWORD_CONFIRMATION_FAILED");
    }
    if (connectionFailed) throw new Error("MAINTENANCE_FAILED");
    await verifyMaintenanceConnection(pool, input.database);
    db = createDatabaseClient(target.href);
    result = input.operation === "init"
      ? await initializeAdmin(db, { username: input.username, password })
      : input.operation === "revoke"
        ? await revokeAdmin(db, { userId: input.userId, expectedVersion: input.expectedVersion })
        : input.operation === "restore"
          ? await restoreAdmin(db, { userId: input.userId, expectedVersion: input.expectedVersion })
          : await resetAdminPassword(db, { userId: input.userId, expectedVersion: input.expectedVersion, password });
  } finally {
    // Secrets are function-local strings. JavaScript cannot guarantee their zeroization.
    const closed = await Promise.allSettled([db?.$disconnect(), pool.end()]);
    cleanupFailed = closed.some(result => result.status === "rejected");
  }
  if (cleanupFailed) throw new Error("MAINTENANCE_FAILED");
  console.log(`MAINTENANCE_SUCCESS operation=${input.operation} userId=${result.userId} version=${result.version}`);
}

try { await main(); }
catch (error) {
  const safe = new Set(["INVALID_ARGUMENTS", "INVALID_MAINTENANCE_TARGET", "MAINTENANCE_IDENTITY_REJECTED", "TTY_REQUIRED",
    "PASSWORD_ENV_REFUSED", "PASSWORD_CONFIRMATION_FAILED", "CONFIRMATION_FAILED", "PASSWORD_INPUT_FAILED", "PASSWORD_INPUT_REJECTED", "CANCELLED"]);
  const message = error && typeof error === "object" && "message" in error ? error.message : undefined;
  const code = error instanceof AdminMaintenanceError ? error.code : safe.has(message) ? message : "MAINTENANCE_FAILED";
  console.error(`ADMIN_MAINTENANCE_${code}; raw connection/driver details withheld.`);
  process.exitCode = 1;
}
