import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runProductionDatabaseTests } from "./database-tests.mjs";

const mode = process.argv[2];
if (mode === "--terminate-idle") {
  try {
    await runProductionDatabaseTests({ beforeCleanup: async ({ pools, control }) => {
      const { pid } = (await pools.runtime.query("SELECT pg_backend_pid() AS pid")).rows[0];
      const observed = new Promise(resolve => pools.runtime.once("error", () => resolve()));
      await control.query("SELECT pg_terminate_backend($1)", [pid]);
      await observed;
    } });
    console.error("IDLE_TERMINATION_WAS_NOT_REJECTED");
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message === "PRODUCTION_DATABASE_POOL_ERROR" ? error.message : "CLEANUP_REGRESSION_FAILED");
    process.exitCode = 1;
  }
} else {
  try {
    assert.equal(mode, undefined);
    let delayedEnd, socketClosed = false, remainingAfterPoolEnd = 0;
    await runProductionDatabaseTests({ beforeCleanup: async ({ pools, control, config }) => {
      const client = await pools.runtime.connect();
      client.once("end", () => { socketClosed = true; });
      const end = client.connection.end.bind(client.connection);
      // Hold the actual PostgreSQL Terminate packet in the client for 200ms.
      // Pool.end still resolves immediately, matching the CI failure window.
      client.connection.end = () => { delayedEnd = delay(200).then(end); };
      client.release();
      const poolEnd = pools.runtime.end.bind(pools.runtime);
      pools.runtime.end = async () => {
        await poolEnd();
        remainingAfterPoolEnd = (await control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename=$2",
          [config.database.name, config.roles.runtime])).rows[0].n;
      };
    } });
    await delayedEnd;
    assert.equal(remainingAfterPoolEnd, 1, "The delayed real connection must outlive Pool.end");
    assert.equal(socketClosed, true, "Cleanup must wait for the real connection to close");
    console.log("PASS cleanup waits for a real PostgreSQL connection that outlives Pool.end");

    // A child process proves an idle error returns nonzero without Node's
    // unhandled-error Client inspection. Capture its output; relay fixed text.
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--terminate-idle"], {
        env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", () => reject(new Error("CLEANUP_REGRESSION_CHILD_FAILED")));
      child.once("close", code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), "PRODUCTION_DATABASE_POOL_ERROR");
    assert.ok(!/connectionParameters|secretKey|Unhandled|Client\s*\{|postgres(?:ql)?:\/\//.test(result.stdout + result.stderr));
    console.log("PASS real idle backend termination exits 1 with a fixed code and no Client dump");
  } catch {
    console.error("PRODUCTION_DATABASE_CLEANUP_REGRESSION_FAILED");
    process.exitCode = 1;
  }
}
