import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LOGIN_IDENTITIES, deploymentDatabaseTag } from "./database-config.mjs";
import { verifyDatabaseLogging } from "../db/log-privacy.mjs";

export const WRITER_IDENTITIES = Object.freeze(LOGIN_IDENTITIES.filter(name => name !== "backup"));
export const MAINTENANCE_LOCK = "mq-production-maintenance-v1";
const quote = value => `"${value.replaceAll('"', '""')}"`;

/** PostgreSQL accepts the SCRAM verifier directly. Only this verifier, never the
 * password, is sent in ALTER ROLE SQL. The restricted ASCII password alphabet
 * avoids SASLprep ambiguity; real SCRAM connections verify interoperability. */
export function passwordVerifier(password) {
  assert.match(password ?? "", /^[A-Za-z0-9_-]{32,128}$/);
  const salt = randomBytes(16), iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  try {
    const stored = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest("base64");
    const server = createHmac("sha256", salted).update("Server Key").digest("base64");
    return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored}:${server}`;
  } finally { salted.fill(0); }
}

/** Bootstrap is an offline, trusted operator. No role name, SQL, credential or
 * target can be supplied by HTTP. This is not an application permission path. */
export async function assertMaintenanceControl(connection, config) {
  const target = (await connection.query(`SELECT current_database() AS db,current_user AS actor,session_user AS login,
    current_setting('server_version_num')::int AS version,r.rolsuper,d.datdba=r.oid AS owns,
    shobj_description(d.oid,'pg_database') AS tag FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
    WHERE d.datname=current_database()`)).rows[0];
  assert.equal(target.db, config.database.name);
  assert.equal(target.actor, target.login);
  assert.equal(target.tag, deploymentDatabaseTag(config));
  assert.ok(target.owns && target.rolsuper && target.version >= 180000 && target.version < 190000);
  assert.ok(!LOGIN_IDENTITIES.some(key => config.roles[key] === target.actor));
  await verifyDatabaseLogging(connection);
  const roles = (await connection.query(`SELECT rolname,rolcanlogin,
    (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit
     OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)) AS unsafe
    FROM pg_roles r WHERE rolname=ANY($1)`, [LOGIN_IDENTITIES.map(key => config.roles[key])])).rows;
  assert.equal(roles.length, LOGIN_IDENTITIES.length);
  assert.ok(roles.every(role => !role.unsafe));
  return roles;
}

export async function assertWritersPaused(connection, config, { includeBackup = false } = {}) {
  const roles = await assertMaintenanceControl(connection, config);
  assert.ok(WRITER_IDENTITIES.every(key => roles.some(role => role.rolname === config.roles[key] && !role.rolcanlogin)));
  const names = (includeBackup ? LOGIN_IDENTITIES : WRITER_IDENTITIES).map(key => config.roles[key]);
  // Roles belong to one deployment. Check the whole cluster: a credential must
  // not remain active through another database when it is being rotated.
  const count = (await connection.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=ANY($1)", [names])).rows[0].n;
  assert.equal(count, 0, "DEPLOYMENT_WRITERS_NOT_DRAINED");
}

async function locked(pool, config, action) {
  const connection = await pool.connect();
  let held = false;
  try {
    await assertMaintenanceControl(connection, config);
    held = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held", [MAINTENANCE_LOCK])).rows[0].held;
    assert.equal(held, true, "DEPLOYMENT_MAINTENANCE_BUSY");
    return await action(connection);
  } catch (cause) { throw new Error("DEPLOYMENT_ROTATION_REJECTED", { cause }); }
  finally {
    try { if (held) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [MAINTENANCE_LOCK]); }
    finally { connection.release(); }
  }
}

async function atomic(connection, action) {
  await connection.query("BEGIN");
  try { const result = await action(); await connection.query("COMMIT"); return result; }
  catch (error) { await connection.query("ROLLBACK"); throw error; }
}

export async function pauseDeploymentWriters(pool, config, { drainTimeoutMs = 5000 } = {}) {
  assert.ok(Number.isSafeInteger(drainTimeoutMs) && drainTimeoutMs >= 0 && drainTimeoutMs <= 30000);
  return locked(pool, config, async connection => {
    await atomic(connection, async () => {
      for (const key of WRITER_IDENTITIES) await connection.query(`ALTER ROLE ${quote(config.roles[key])} NOLOGIN`);
    });
    const deadline = Date.now() + drainTimeoutMs;
    // NOLOGIN does not terminate an existing connection. Never kill unknown
    // work: reject on timeout, leave the gate CLOSED and ask the operator to
    // stop the application/maintenance clients before retrying.
    while ((await connection.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=ANY($1)",
      [WRITER_IDENTITIES.map(key => config.roles[key])])).rows[0].n !== 0) {
      assert.ok(Date.now() < deadline, "DEPLOYMENT_WRITERS_NOT_DRAINED");
      await delay(25);
    }
    return { paused: true, backupReadOnlyLoginEnabled: (await connection.query("SELECT rolcanlogin FROM pg_roles WHERE rolname=$1", [config.roles.backup])).rows[0].rolcanlogin };
  });
}

export async function resumeDeploymentWriters(pool, config) {
  return locked(pool, config, async connection => {
    await assertWritersPaused(connection, config);
    return atomic(connection, async () => {
      for (const key of LOGIN_IDENTITIES) await connection.query(`ALTER ROLE ${quote(config.roles[key])} LOGIN`);
      return { resumed: true, applicationRestartAndAuditRequired: true };
    });
  });
}

export async function rotateDeploymentPasswords(pool, config, passwords) {
  assert.deepEqual(Object.keys(passwords).sort(), [...LOGIN_IDENTITIES].sort());
  assert.equal(new Set(Object.values(passwords)).size, LOGIN_IDENTITIES.length);
  const verifiers = Object.fromEntries(LOGIN_IDENTITIES.map(key => [key, passwordVerifier(passwords[key])]));
  return locked(pool, config, async connection => {
    await assertWritersPaused(connection, config);
    // Password replacement also closes the read-only login. Checking an empty
    // connection list alone would race a new backup connection using its old
    // password. Leave NOLOGIN on failure; explicit resume opens it again.
    await connection.query(`ALTER ROLE ${quote(config.roles.backup)} NOLOGIN`);
    await assertWritersPaused(connection, config, { includeBackup: true });
    return atomic(connection, async () => {
      for (const key of LOGIN_IDENTITIES) await connection.query(`ALTER ROLE ${quote(config.roles[key])} PASSWORD '${verifiers[key]}'`);
      return { passwordsRotated: LOGIN_IDENTITIES.length, writersRemainPaused: true };
    });
  });
}

export async function revokeDeploymentSessions(pool, config) {
  return locked(pool, config, async connection => {
    await assertWritersPaused(connection, config);
    return atomic(connection, async () => ({ revokedSessions: (await connection.query('DELETE FROM public."Session"')).rowCount,
      writersRemainPaused: true }));
  });
}

export async function rotateDeploymentSigningKeys(pool, config, keys) {
  assert.deepEqual(Object.keys(keys).sort(), ["moderation", "previousModeration", "previousPublication", "publication"]);
  for (const value of Object.values(keys)) assert.match(value ?? "", /^[a-f0-9]{64}$/);
  assert.equal(new Set(Object.values(keys)).size, 4, "DEPLOYMENT_SIGNING_KEY_REUSE_REJECTED");
  const values = Object.fromEntries(Object.entries(keys).map(([name, value]) => [name, Buffer.from(value, "hex")]));
  try {
    return await locked(pool, config, async connection => {
      await assertWritersPaused(connection, config);
      return atomic(connection, async () => {
        const publication = (await connection.query("SELECT secret FROM mq_publish_private.signing_key WHERE id=1 FOR UPDATE")).rows[0];
        const moderation = (await connection.query("SELECT secret FROM mq_comment_private.moderation_key WHERE id=1 FOR UPDATE")).rows[0];
        assert.ok(publication?.secret.length === 32 && moderation?.secret.length === 32);
        assert.ok(timingSafeEqual(publication.secret, values.previousPublication) && timingSafeEqual(moderation.secret, values.previousModeration));
        await connection.query("UPDATE mq_publish_private.signing_key SET secret=$1 WHERE id=1", [values.publication]);
        await connection.query("UPDATE mq_comment_private.moderation_key SET secret=$1 WHERE id=1", [values.moderation]);
        const revokedSessions = (await connection.query('DELETE FROM public."Session"')).rowCount;
        return { signingKeysRotated: 2, revokedSessions, writersRemainPaused: true };
      });
    });
  } finally { for (const value of Object.values(values)) value.fill(0); }
}
