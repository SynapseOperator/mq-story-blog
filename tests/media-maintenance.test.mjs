import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseMediaMaintenanceArguments, recoverMediaAsset } from "../scripts/media/maintenance.mjs";

test("media maintenance accepts exactly one operation, database and asset ID", () => {
  const id = randomUUID();
  for (const operation of ["diagnose", "recover"]) {
    assert.deepEqual(parseMediaMaintenanceArguments(["--operation", operation, "--database", "mq_synthetic", "--asset-id", id]),
      { operation, database: "mq_synthetic", id });
  }
  const valid = ["--operation", "recover", "--database", "mq_synthetic", "--asset-id", id];
  for (const args of [[], valid.slice(0, -1), [...valid, "--password", "not-a-real-password"],
    [...valid, "--storage-key", randomUUID()], [...valid, "--path", "../other"], [...valid, "--all", "true"],
    [...valid, "--database", "mq_other"], valid.map(value => value === "mq_synthetic" ? "postgres" : value),
    valid.map(value => value === id ? "../other" : value)]) {
    assert.throws(() => parseMediaMaintenanceArguments(args), /^Error: INVALID_ARGUMENTS$/);
  }
});

test("offline recovery requires explicit confirmation before touching any database or file", async () => {
  await assert.rejects(recoverMediaAsset(null, null, randomUUID()), /^Error: OFFLINE_CONFIRMATION_REQUIRED$/);
});

test("media cleanup CLI rejects piped recovery and credential/path arguments without exposing them", () => {
  const id = randomUUID(), secret = "synthetic-password-not-a-real-account";
  const args = ["scripts/media/maintain.mjs", "--operation", "recover", "--database", "mq_synthetic", "--asset-id", id];
  const env = { ...process.env, MQ_MEDIA_MAINTENANCE_DATABASE_URL: `postgresql://mq_synthetic_maint:${secret}@127.0.0.1:1/mq_synthetic` };
  const piped = spawnSync(process.execPath, args, { cwd: process.cwd(), env, encoding: "utf8", timeout: 15_000 });
  assert.equal(piped.status, 1); assert.match(piped.stderr, /MEDIA_TTY_REQUIRED/);
  assert.ok(!piped.stderr.includes(secret)); assert.equal(piped.stdout, "");
  const bad = spawnSync(process.execPath, [...args, "--password", secret], { cwd: process.cwd(), env, encoding: "utf8", timeout: 15_000 });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /MEDIA_INVALID_ARGUMENTS/);
  assert.ok(!bad.stderr.includes(secret)); assert.equal(bad.stdout, "");
});
