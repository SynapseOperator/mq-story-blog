import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout, clearTimeout } from "node:timers";
import test from "node:test";

// A real Linux pseudo-terminal exercises the actual command's confirmation and
// hidden input. Its DB modules are fixtures; admin-tests.mjs independently uses
// PostgreSQL. This test neither holds nor writes a real account password.
test("Linux PTY: production admin CLI confirms target, never echoes password and completes", { skip: process.platform !== "linux" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "mq-admin-pty-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "mq-admin-pty-"));
    await rm(directory, { recursive: true, force: true });
  });
  const id = "12345678-1234-4234-8234-123456789abc", userId = "12345678-1234-4234-8234-987654321abc";
  const password = "Only-a-synthetic-PTY-input-42!";
  const config = { version: 1, environment: "production", deploymentId: id, database: { name: "mq_production", host: "postgres", port: 5432 },
    roles: { maintenance: "mq_production_12345678_maintenance" } };
  const modules = {
    "pty:runtime": `export async function readDeploymentManifest() { return ${JSON.stringify(config)}; }
      export async function readDeploymentFile() { return 'postgresql://mq_production_12345678_maintenance:synthetic@postgres:5432/mq_production'; }`,
    "pty:pg": `export default { Pool: class {
      on() {} async end() { this.ending = true; }
      async query() { return { rows: [{ database:'mq_production',actor:'mq_production_12345678_maintenance',login:'mq_production_12345678_maintenance',version:180006,tag:'mq-deployment-v1:production:${id}' }] }; }
    } };`,
    "pty:audit": "export async function auditPrivileges() {}",
    "pty:logging": "export async function verifyDatabaseLogging() {}",
    "pty:client": "export function createAuthDatabaseClient() { return { async $disconnect() {} }; }",
    "pty:policy": `export function parseMaintenanceArguments() { return { database:'mq_production',operation:'init',username:'synthetic_admin' }; }
      export async function verifyMaintenanceConnection() {}`,
    "pty:domain": `export class AdminMaintenanceError extends Error {}
      export async function initializeAdmin(_db, input) { if (input.password!==${JSON.stringify(password)}) throw new Error('WRONG_SYNTHETIC_INPUT'); return { userId:'${userId}',version:0 }; }
      export async function revokeAdmin() {} export async function restoreAdmin() {} export async function resetAdminPassword() {}`,
  };
  const loader = join(directory, "loader.mjs");
  await writeFile(loader, `import { registerHooks } from 'node:module';
    const modules=${JSON.stringify(modules)};
    registerHooks({
      resolve(specifier, context, next) {
        if (!context.parentURL?.endsWith('/scripts/production/admin-cli.mjs')) return next(specifier,context);
        const key=({ 'pg':'pty:pg','./runtime-config.mjs':'pty:runtime','./database.mjs':'pty:audit',
          '../db/log-privacy.mjs':'pty:logging','../../src/server/auth/database.ts':'pty:client',
          '../admin/maintenance-policy.mjs':'pty:policy','../../src/server/admin/maintenance.ts':'pty:domain' })[specifier];
        return key?{url:key,shortCircuit:true}:next(specifier,context);
      }, load(url,context,next) { return modules[url]?{format:'module',source:modules[url],shortCircuit:true}:next(url,context); }
    });
    // Widen the real terminal scheduling window after a visible prompt. A
    // prompt must not become visible while the kernel can still echo input;
    // the delayed write return makes this deterministic on fast machines too.
    const write = process.stdout.write;
    process.stdout.write = function(chunk, ...args) {
      const result = write.call(this, chunk, ...args);
      if (typeof chunk === 'string' && chunk.includes('password (hidden'))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
      return result;
    };`, { mode: 0o600 });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = [process.execPath, "--import", loader, fileURLToPath(new globalThis.URL("../scripts/production/admin-cli.mjs", import.meta.url)),
    "--operation", "init", "--username", "synthetic_admin", `--confirm-production=${id}`].map(quote).join(" ");
  const result = await new Promise((done, reject) => {
    const child = spawn("script", ["--quiet", "--return", "--flush", "--command", command, "/dev/null"], {
      env: { ...process.env, MQ_DEPLOYMENT_ENV: "production", MQ_DEPLOYMENT_CONFIG: "/fixture/deployment.json", MAINTENANCE_DATABASE_URL_FILE: "/fixture/maintenance" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "", error = "", stage = 0;
    const timer = setTimeout(() => { child.kill(); reject(new Error("SYNTHETIC_PTY_TIMEOUT")); }, 15000);
    child.stdout.on("data", bytes => {
      output += bytes.toString();
      if (stage === 0 && output.includes(`Type exactly: INIT ${id} synthetic_admin`)) { stage++; child.stdin.write(`INIT ${id} synthetic_admin\n`); }
      if (stage === 1 && output.includes("New password (hidden, 12–128 characters): ")) { stage++; child.stdin.write(password + "\n"); }
      if (stage === 2 && output.includes("Repeat new password (hidden): ")) { stage++; child.stdin.write(password + "\n"); }
    });
    child.stderr.on("data", bytes => { error += bytes.toString(); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("SYNTHETIC_PTY_LAUNCH_FAILED")); });
    child.once("close", code => { clearTimeout(timer); done({ code, output, error, stage }); });
  });
  // Fixed assertion messages keep a failed test from dumping its input/output.
  assert.equal(result.code, 0, "PTY command must succeed");
  assert.equal(result.stage, 3, "All real terminal prompts must be completed");
  assert.equal(result.output.includes(password) || result.error.includes(password), false, "Password must never be echoed");
  assert.ok(result.output.includes(`"userId":"${userId}"`), "Successful maintenance receipt must be visible");
  assert.equal(result.error, "", "No underlying diagnostic may escape");
});
