import pg from "pg";
import { URL } from "node:url";
import { loadRuntimeEnvironment } from "./runtime-config.mjs";
import { auditRuntimeDatabase } from "./database.mjs";

// Docker reads only the exit status. Never print connection strings or driver
// errors into its health log (which is available through docker inspect).
try {
  const { env, config } = await loadRuntimeEnvironment(process.env);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  try { await auditRuntimeDatabase(pool, config); }
  finally { await pool.end(); }
  const response = await globalThis.fetch("http://127.0.0.1:3000/api/stories", {
    signal: AbortSignal.timeout(3000), headers: { Host: new URL(config.origin).host },
  });
  if (!response.ok) throw new Error();
  await response.body?.cancel();
} catch { process.exitCode = 1; }
