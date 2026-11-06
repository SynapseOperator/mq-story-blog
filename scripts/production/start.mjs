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
  try { await auditRuntimeDatabase(pool, config); }
  finally { await pool.end(); }
  await import("../../server.js");
} catch {
  console.error("MQ_STARTUP_REJECTED");
  process.exitCode = 1;
}
