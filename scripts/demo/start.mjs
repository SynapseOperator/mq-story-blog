import { spawn } from "node:child_process";
import pg from "pg";
import { readDeploymentFile } from "../production/runtime-config.mjs";
import { validateDeploymentConfig } from "../production/database-config.mjs";
import { auditRuntimeDatabase } from "../production/database.mjs";

try {
  const saved = JSON.parse(await readDeploymentFile("/run/mq-demo/runtime/runtime.json", { secret: true }));
  const config = validateDeploymentConfig({ version: 1, environment: "staging", deploymentId: saved.deploymentId, database: saved.database });
  const pool = new pg.Pool({ connectionString: saved.DATABASE_URL, max: 1 });
  try { await auditRuntimeDatabase(pool, config); } finally { await pool.end(); }
  // Explicit local-development contract; never invoke or weaken the production loader.
  const env = { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", HOSTNAME: "0.0.0.0", PORT: "3000",
    MQ_AUTH_ENABLED: "true", AUTH_ORIGIN: saved.origin, AUTH_ALLOW_LOCAL_HTTP: "true", MQ_MEDIA_ENABLED: "true",
    MQ_PUBLISH_ENABLED: "true", MQ_COMMENTS_ENABLED: "true", MQ_MEDIA_ENV: "development",
    MQ_MEDIA_DEVELOPMENT_ROOT: "/var/lib/mq-demo/development", MQ_MEDIA_TEST_ROOT: "/var/lib/mq-demo/test" };
  for (const key of ["DATABASE_URL", "AUTH_SECRET", "SESSION_STORAGE_KEY", "MQ_PUBLISH_SIGNING_KEY", "MQ_COMMENT_SIGNING_KEY"]) env[key] = saved[key];
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"], { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", code => { process.exitCode = code ?? 1; });
} catch { console.error("DEMO_APP_START_REJECTED"); process.exitCode = 1; }
