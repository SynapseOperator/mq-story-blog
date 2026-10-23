import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";

const execute = promisify(execFile);
const image = "postgres:18.6-bookworm";
const root = fileURLToPath(new URL("../../", import.meta.url));
const configFile = new URL("../../config/postgresql/log-privacy.conf", import.meta.url);
let docker = "docker";
if (process.platform === "win32") {
  const perUserDocker = join(process.env.LOCALAPPDATA ?? "", "Programs", "DockerDesktop", "resources", "bin", "docker.exe");
  try { await access(perUserDocker); docker = perUserDocker; } catch { /* PATH fallback. */ }
}

// Raw driver/container output never reaches the terminal or CI log, even on failure.
async function dockerCommand(args, env = process.env) {
  try {
    return await execute(docker, args, { cwd: root, env, windowsHide: true, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    throw new Error(`Test-owned Docker command failed: ${args[0]} (raw output withheld)`);
  }
}

async function protectedEvidenceDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "mq-auth-log-audit-"));
  if (process.platform === "win32") {
    const { stdout } = await execute("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
    const sid = stdout.match(/S-1-5-[0-9-]+/)?.[0];
    assert.ok(sid, "Could not determine evidence owner SID");
    await execute("icacls.exe", [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { windowsHide: true });
  } else {
    const { chmod } = await import("node:fs/promises");
    await chmod(directory, 0o700);
  }
  return directory;
}

const settings = (await readFile(configFile, "utf8")).split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#")).map((line) => {
  const match = line.match(/^([a-z_]+)\s*=\s*(.*?)\s*$/);
  assert.ok(match, "Invalid test logging configuration");
  const value = match[2].startsWith("'") ? match[2].slice(1, -1) : match[2];
  return [match[1], value];
});

async function auditProfile(profile, evidenceDirectory) {
  const id = randomUUID().replaceAll("-", "");
  const name = `mq-auth-log-audit-${profile}-${id}`;
  assert.match(name, /^mq-auth-log-audit-(default|protected)-[a-f0-9]{32}$/);
  const password = randomBytes(32).toString("hex");
  const user = "mq_log_audit";
  const parameters = profile === "protected" ? settings.flatMap(([key, value]) => ["-c", `${key}=${value}`]) : [];
  let started = false;
  let pool;
  let failure;
  const result = { profile, expectedDatabaseErrors: 0, clientSensitiveDetailObserved: false };
  try {
    await dockerCommand(["run", "--detach", "--name", name, "--label", `mq.auth-log-audit=${id}`,
      "--publish", "127.0.0.1::5432", "--tmpfs", "/var/lib/postgresql:rw,size=384m",
      "--memory", "512m", "--cpus", "1", "--env", `POSTGRES_USER=${user}`, "--env", `POSTGRES_DB=${user}`,
      "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", image, "postgres", ...parameters],
    { ...process.env, POSTGRES_PASSWORD: password });
    started = true;
    const { stdout } = await dockerCommand(["port", name, "5432/tcp"]);
    const port = Number(stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1]);
    assert.ok(port > 0, "Unexpected loopback audit port mapping");
    pool = new pg.Pool({ host: "127.0.0.1", port, user, password, database: user, max: 1, connectionTimeoutMillis: 1000 });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { await pool.query("SELECT 1"); ready = true; break; } catch { await delay(250); }
    }
    assert.ok(ready, "Audit PostgreSQL startup timed out");
    const version = (await pool.query("SHOW server_version")).rows[0].server_version;
    assert.match(version, /^18\.6\b/);
    result.version = version;
    if (profile === "protected") {
      for (const [key, value] of settings) {
        const row = (await pool.query("SELECT current_setting($1) AS value", [key])).rows[0];
        assert.equal(row.value, value, `Logging setting not effective: ${key}`);
      }
    }
    // Execute the actual committed authentication migration in an otherwise empty,
    // disposable instance. Existing development/test instances are never connected.
    await pool.query(await readFile(new URL("../../prisma/migrations/202610230003_username_auth/migration.sql", import.meta.url), "utf8"));
    const email = `${randomUUID()}@accounts.invalid`;
    const passwordMarker = `synthetic_password_hash_${id}`;
    const tokenMarker = `synthetic_session_token_${id}`;
    const primaryMarker = `synthetic_invalid_integer_${id}`;
    const owner = randomUUID();
    const insertUser = 'INSERT INTO "User" (id,name,email,username,"updatedAt") VALUES ($1,$2,$3,$4,now())';
    const expectError = async (text, values, code) => {
      try { await pool.query(text, values); } catch (error) {
        // Never assert against/print the Error object, DETAIL or query parameters.
        assert.ok(error.code === code, `Expected database error SQLSTATE ${code}`);
        result.expectedDatabaseErrors += 1;
        if (typeof error.detail === "string" && [email, passwordMarker, tokenMarker].some((marker) => error.detail.includes(marker))) {
          result.clientSensitiveDetailObserved = true;
        }
        return;
      }
      throw new Error(`Expected database error SQLSTATE ${code}`);
    };
    await expectError(insertUser, [owner, "synthetic", email, "INVALID"], "23514");
    await pool.query(insertUser, [owner, "synthetic", email, `user_${id.slice(0, 16)}`]);
    await expectError(insertUser, [randomUUID(), "synthetic", email, `other_${id.slice(0, 16)}`], "23505");
    await expectError('INSERT INTO "Account" (id,"accountId","providerId","userId",password,"updatedAt") VALUES ($1,$2,$3,$2,$4,now())',
      [randomUUID(), owner, "forbidden", passwordMarker], "23514");
    await expectError('INSERT INTO "Session" (id,"expiresAt",token,"userId","updatedAt") VALUES ($1,NULL,$2,$3,now())',
      [randomUUID(), tokenMarker, owner], "23502");
    await pool.query('INSERT INTO "Session" (id,"expiresAt",token,"userId","updatedAt") VALUES ($1,now(),$2,$3,now())',
      [randomUUID(), tokenMarker, owner]);
    await expectError('INSERT INTO "Session" (id,"expiresAt",token,"userId","updatedAt") VALUES ($1,now(),$2,$3,now())',
      [randomUUID(), tokenMarker, owner], "23505");
    await expectError('INSERT INTO "Session" (id,"expiresAt",token,"userId","updatedAt") VALUES ($1,now(),$2,$3,now())',
      [randomUUID(), randomUUID(), randomUUID()], "23503");
    await expectError("SELECT 1 / 0, $1::text", [passwordMarker], "22012");
    await delay(100);
    const captured = await dockerCommand(["logs", name]);
    const constraintLogs = captured.stdout + captured.stderr;
    await writeFile(join(evidenceDirectory, `${profile}-constraints.raw.log`), constraintLogs, { mode: 0o600 });
    const leakedMarkers = [email, passwordMarker, tokenMarker].filter((marker) => constraintLogs.includes(marker)).length;
    result.constraintMarkersFound = leakedMarkers;
    result.errorAuditPresent = constraintLogs.includes("ERROR:");
    assert.ok(result.errorAuditPresent, "Database ERROR audit must remain enabled");
    if (profile === "default") {
      assert.ok(leakedMarkers === 3, "Default log reproduction must include all three synthetic field markers");
      assert.ok(constraintLogs.includes("DETAIL:"), "Default CHECK/unique/NOT NULL errors must reproduce DETAIL logging");
    } else {
      assert.ok(leakedMarkers === 0, "Protected constraint logs exposed a synthetic sensitive field");
      assert.ok(!/DETAIL:|STATEMENT:|CONTEXT:|QUERY:/.test(constraintLogs), "Protected logs retained sensitive detail or query context");
      for (const code of ["23514", "23505", "23502", "23503", "22012"]) {
        assert.ok(constraintLogs.includes(` ${code} ERROR:`), `Missing audited SQLSTATE ${code}`);
      }
      for (const constraint of ["username_canonical", "User_email_key", "password_credentials_only", "Session_token_key", "Session_userId_fkey"]) {
        assert.ok(constraintLogs.includes(constraint), "Constraint identity missing from error audit");
      }
    }
    // A deliberate negative control documents the protection boundary: type
    // conversion puts input in the primary ERROR itself, even with TERSE and binds.
    await expectError("SELECT $1::integer", [primaryMarker], "22P02");
    await delay(100);
    const after = await dockerCommand(["logs", name]);
    const allLogs = after.stdout + after.stderr;
    await writeFile(join(evidenceDirectory, `${profile}-primary-error.raw.log`), allLogs, { mode: 0o600 });
    result.primaryErrorStillIncludesInput = allLogs.includes(primaryMarker);
    assert.ok(result.primaryErrorStillIncludesInput, "Primary-error negative control unexpectedly changed; investigate before changing claims");
    assert.ok(result.clientSensitiveDetailObserved, "Server log settings must not be mistaken for driver error redaction");
  } catch (error) {
    failure = error instanceof assert.AssertionError ? error : new Error("Database log audit failed (raw diagnostic withheld)");
  } finally {
    if (pool) await pool.end();
    if (started) {
      const { stdout } = await dockerCommand(["inspect", "--format", '{{index .Config.Labels "mq.auth-log-audit"}}', name]);
      assert.ok(stdout.trim() === id, "Refusing cleanup of a container not owned by this run");
      await dockerCommand(["rm", "--force", name]);
    }
  }
  if (failure) throw failure;
  return result;
}

async function main() {
  const directory = await protectedEvidenceDirectory();
  console.log(`Restricted synthetic-only raw evidence: ${directory}`);
  const results = [];
  for (const profile of ["default", "protected"]) {
    results.push(await auditProfile(profile, directory));
  }
  const report = { image, results, cleanup: "only two test-owned tmpfs containers removed; no existing containers/databases/env files touched" };
  await writeFile(join(directory, "summary.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof assert.AssertionError ? error.message : "Database log audit failed; raw diagnostics withheld");
  process.exitCode = 1;
});
