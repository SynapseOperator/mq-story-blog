import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("rotation CLI refuses absent confirmation, credential argv and mismatched DB target without leaking inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-rotation-boundary-"));
  const id = randomUUID(), manifest = join(directory, "deployment.json"), secret = join(directory, "operator.url");
  const password = randomBytes(32).toString("hex");
  await writeFile(manifest, JSON.stringify({ version: 1, environment: "production", deploymentId: id,
    database: { host: "127.0.0.1", port: 1, name: "mq_production" }, origin: "https://mq.example.invalid",
    media: { root: join(directory, "media"), minFreeBytes: 268435456 } }), { mode: 0o444 });
  await writeFile(secret, `postgresql://operator:${password}@127.0.0.1:1/mq_development`, { mode: 0o600 });
  try {
    for (const args of [["pause"], ["pause", `--confirm-deployment=${randomUUID()}`],
      ["pause", `--confirm-deployment=${id}`, password], ["database", `--confirm-deployment=${id}`],
      ["signing", `--confirm-deployment=${id}`], ["revoke-sessions", `--confirm-deployment=${id}`],
      ["resume", `--confirm-deployment=${id}`]]) {
      const result = spawnSync(process.execPath, [resolve("scripts/production/rotation-cli.mjs"), ...args], {
        env: { ...process.env, MQ_DEPLOYMENT_ENV: "production", MQ_DEPLOYMENT_CONFIG: manifest, BOOTSTRAP_DATABASE_URL_FILE: secret }, encoding: "utf8", timeout: 10000,
      });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /DEPLOYMENT_ROTATION_REJECTED/);
      assert.ok(!result.stderr.includes(password) && !result.stderr.includes("postgresql:") && !result.stderr.includes("mq_development"));
    }
  } finally {
    // Only this newly created exact random temporary directory is removed.
    await chmod(manifest, 0o600); await rm(directory, { recursive: true });
  }
});
