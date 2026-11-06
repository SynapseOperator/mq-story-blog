import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readDeploymentFile, readDeploymentManifest, loadRuntimeEnvironment } from "./runtime-config.mjs";
import { assertDatabaseUrl } from "./database-config.mjs";
import { createAuthDatabaseClient } from "../../src/server/auth/database.ts";
import { initializeAdmin, revokeAdmin } from "../../src/server/admin/maintenance.ts";
import { verifyMaintenanceConnection } from "../admin/maintenance-policy.mjs";
import { createLocalMediaStore } from "../../src/server/media/local-store.ts";
import { initializeMediaVolume } from "./init-media.mjs";

// Synthetic lab only. Production maintenance uses the separately confirmed CLI.
try {
  const config = await readDeploymentManifest(process.env.MQ_DEPLOYMENT_CONFIG);
  assert.equal(process.env.MQ_SYNTHETIC_LAB, "true");
  assert.equal(config.environment, "staging");
  assert.match(config.database.name, /^mq_staging_[a-f0-9]{32}$/);
  const action = process.argv[2];
  if (action === "media-init") {
    await initializeMediaVolume(config);
    console.log(JSON.stringify({ initialized: true }));
  } else if (action === "disk-refusal") {
    await initializeMediaVolume(config);
    const store = await createLocalMediaStore({ projectRoot: process.cwd(), environment: config.environment,
      root: config.media.root, deploymentId: config.deploymentId, minimumFreeBytes: config.media.minFreeBytes,
      maxVariantBytes: 4 * 1024 * 1024 });
    await assert.rejects(store.write(randomUUID(), "display", Buffer.from("synthetic output")), error => error.code === "LOW_DISK_SPACE");
    // The 8MiB container tmpfs is below the real statfs reserve; do not fill a host disk.
    await assert.rejects(() => loadRuntimeEnvironment(process.env), /DEPLOYMENT_RUNTIME_CONFIG_REJECTED/);
    console.log(JSON.stringify({ diskRefused: true }));
  } else if (action === "direct-request") {
    const response = await globalThis.fetch("http://app:3000/api/admin/stories", { headers: {
      origin: config.origin, "x-mq-proxy-key": "forged", "x-mq-client-ip": "127.0.0.1",
    } });
    console.log(JSON.stringify({ status: response.status }));
  } else if (["admin-init", "admin-revoke"].includes(action)) {
    const url = (await readDeploymentFile(process.env.MAINTENANCE_DATABASE_URL_FILE, { secret: true })).trim();
    assertDatabaseUrl(url, config, "maintenance");
    const pg = await import("pg"), pool = new pg.default.Pool({ connectionString: url, max: 1 });
    try { await verifyMaintenanceConnection(pool, config.database.name); } finally { await pool.end(); }
    const client = createAuthDatabaseClient(url);
    try {
      let result;
      if (action === "admin-init") {
        const accounts = JSON.parse(await readDeploymentFile(process.env.MQ_LAB_ACCOUNTS_FILE, { secret: true }));
        assert.match(accounts.admin.username, /^lab_admin_[a-f0-9]+$/);
        result = await initializeAdmin(client, accounts.admin);
      } else {
        const grant = await client.adminGrant.findUniqueOrThrow({ where: { id: 1 }, select: { userId: true, version: true } });
        result = await revokeAdmin(client, { userId: grant.userId, expectedVersion: grant.version });
      }
      console.log(JSON.stringify({ userId: result.userId, version: result.version }));
    } finally { await client.$disconnect(); }
  } else throw new Error("LAB_ACTION_REJECTED");
} catch {
  console.error("MQ_SYNTHETIC_LAB_ACTION_REJECTED"); process.exitCode = 1;
}
