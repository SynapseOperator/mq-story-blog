import pg from "pg";
import { loadRuntimeEnvironment } from "./runtime-config.mjs";
import { auditRuntimeDatabase } from "./database.mjs";

// No HTTP listener is opened until the deployment identity, secret files,
// runtime grants and private media mount have been checked.
try {
  const { env, config } = await loadRuntimeEnvironment(process.env);
  process.env = env;
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  // pg attaches its Client to idle errors; never let EventEmitter dump it.
  let poolFailed = false;
  pool.on("error", () => { poolFailed = true; });
  try { await auditRuntimeDatabase(pool, config); }
  finally { await pool.end(); }
  if (poolFailed) throw new Error("DEPLOYMENT_DATABASE_POOL_FAILED");
  await import("../../server.js");
} catch {
  console.error("MQ_STARTUP_REJECTED");
  process.exitCode = 1;
}
