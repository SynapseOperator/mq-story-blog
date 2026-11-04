import { createInterface } from "node:readline/promises";
import pg from "pg";
import { createDatabaseClient } from "../../src/lib/db/client.ts";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";
import { MediaLifecycleError } from "../../src/server/media/lifecycle.ts";
import { MEDIA_DISPLAY_LIMIT } from "../../src/server/media/processor.ts";
import { validateMaintenanceTarget } from "../admin/maintenance-policy.mjs";
import { parseMediaMaintenanceArguments, diagnoseMediaAsset, recoverMediaAsset } from "./maintenance.mjs";
import { verifyMediaMaintenanceConnection } from "./maintenance-privileges.mjs";

// Local, one asset, no default env-file loading or credentials/path arguments.
async function main() {
  const input = parseMediaMaintenanceArguments(process.argv.slice(2));
  const target = validateMaintenanceTarget(process.env.MQ_MEDIA_MAINTENANCE_DATABASE_URL, input.database);
  if (input.operation === "recover" && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error("TTY_REQUIRED");
  const pool = new pg.Pool({ connectionString: target.href, max: 1, connectionTimeoutMillis: 5000 });
  pool.on("error", () => {});
  let db;
  try {
    await verifyMediaMaintenanceConnection(pool, input.database);
    if (input.operation === "recover") {
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      const phrase = `RECOVER ${input.database} ${input.id} OFFLINE`;
      try {
        console.log("Stop every application/upload process using this database and private volume before continuing. READY assets are never cleaned by this command.");
        if (await reader.question(`Type exactly to confirm: ${phrase}\n> `) !== phrase) throw new Error("CONFIRMATION_FAILED");
      } finally { reader.close(); }
      await verifyMediaMaintenanceConnection(pool, input.database);
    }
    const store = await createLocalMediaStore({ projectRoot: process.cwd(),
      roots: { development: process.env.MQ_MEDIA_DEVELOPMENT_ROOT ?? "", test: process.env.MQ_MEDIA_TEST_ROOT ?? "" },
      environment: process.env.MQ_MEDIA_ENV, maxVariantBytes: MEDIA_DISPLAY_LIMIT });
    db = createDatabaseClient(target.href);
    const result = input.operation === "diagnose" ? await diagnoseMediaAsset(db, store, input.id)
      : await recoverMediaAsset(db, store, input.id, { offlineConfirmed: true });
    console.log(JSON.stringify({ operation: input.operation, ...result }));
  } finally { await Promise.all([db?.$disconnect(), pool.end()]); }
}

try { await main(); }
catch (error) {
  const known = new Set(["INVALID_ARGUMENTS", "INVALID_MAINTENANCE_TARGET", "TTY_REQUIRED", "CONFIRMATION_FAILED",
    "MEDIA_MAINTENANCE_IDENTITY_REJECTED", "OFFLINE_CONFIRMATION_REQUIRED"]);
  const code = error instanceof MediaLifecycleError ? error.mediaCode : known.has(error?.message) ? error.message : "MAINTENANCE_FAILED";
  console.error(`MEDIA_${code}; private connection and filesystem details withheld.`);
  process.exitCode = 1;
}
