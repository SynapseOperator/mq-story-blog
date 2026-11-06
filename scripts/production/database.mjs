import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { FUNCTION_IDENTITIES, LOGIN_IDENTITIES, deploymentDatabaseTag, assertDatabaseUrl } from "./database-config.mjs";
import { deploymentPrivilegePolicy } from "./database-policy.mjs";
import { logPrivacySettings, verifyDatabaseLogging } from "../db/log-privacy.mjs";
import { runPrisma } from "../db/prisma-command.mjs";

const schemas = ["public", "mq_publish_private", "mq_comment_private"];
const quote = name => `"${name.replaceAll('"', '""')}"`;
const tableSql = name => name.split(".").map(quote).join(".");
const allRoleNames = config => [...LOGIN_IDENTITIES.map(key => config.roles[key]), ...Object.values(config.roles.owners)];

async function target(connection, config, { initialized = true, bootstrap = false, identity } = {}) {
  const context = (await connection.query(`SELECT current_database() AS db,current_user AS actor,session_user AS login,
    current_setting('server_version_num')::int AS version,d.datdba,r.oid,r.rolsuper,
    shobj_description(d.oid,'pg_database') AS tag FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
    WHERE d.datname=current_database()`)).rows[0];
  assert.equal(context.db, config.database.name);
  assert.equal(context.actor, context.login);
  assert.ok(context.version >= 180000 && context.version < 190000);
  if (initialized) assert.equal(context.tag, deploymentDatabaseTag(config));
  if (identity) assert.equal(context.actor, config.roles[identity]);
  if (bootstrap) {
    assert.ok(context.rolsuper && context.datdba === context.oid);
    assert.ok(!allRoleNames(config).includes(context.actor));
  }
  return context;
}

async function transaction(pool, failure, action) {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const result = await action(connection);
    await connection.query("COMMIT");
    return result;
  } catch (cause) {
    await connection.query("ROLLBACK").catch(() => {});
    throw new Error(failure, { cause });
  } finally { connection.release(); }
}

/** One-time bootstrap in a freshly created, explicitly addressed PG18 DB.
 * Does not create databases, adopt existing roles, change global logging, or
 * touch other deployments. Passwords are in-memory inputs, never argv/output. */
export async function bootstrapDeploymentDatabase(pool, config, passwords) {
  assert.deepEqual(Object.keys(passwords).sort(), [...LOGIN_IDENTITIES].sort(), "DEPLOYMENT_PASSWORD_SET_REJECTED");
  for (const key of LOGIN_IDENTITIES) {
    assert.match(passwords[key] ?? "", /^[A-Za-z0-9_-]{32,128}$/, "DEPLOYMENT_PASSWORD_REJECTED");
  }
  assert.equal(new Set(LOGIN_IDENTITIES.map(key => passwords[key])).size, LOGIN_IDENTITIES.length,
    "DEPLOYMENT_PASSWORD_REUSE_REJECTED");
  await verifyDatabaseLogging(pool);
  return transaction(pool, "DEPLOYMENT_BOOTSTRAP_REJECTED", async connection => {
    const context = await target(connection, config, { initialized: false, bootstrap: true });
    assert.equal(context.tag, null);
    assert.equal((await connection.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'`)).rows[0].n, 0);
    assert.equal((await connection.query(`SELECT
      (SELECT count(*) FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public','information_schema')) +
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') +
      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') +
      (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql') AS n`)).rows[0].n, "0");
    assert.equal((await connection.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname=ANY($1)", [allRoleNames(config)])).rows[0].n, 0);
    for (const key of LOGIN_IDENTITIES) {
      // Password alphabet is validated above, before forming the one-time DDL.
      // PostgreSQL logging policy is configured first below and verified by the
      // CLI before bootstrap; no statement text/error detail is relayed.
      await connection.query(`CREATE ROLE ${quote(config.roles[key])} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${passwords[key]}'`);
    }
    for (const name of Object.values(config.roles.owners)) {
      await connection.query(`CREATE ROLE ${quote(name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
    }
    const database = quote(config.database.name), migration = quote(config.roles.migration);
    await connection.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await connection.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await connection.query(`ALTER SCHEMA public OWNER TO ${migration}`);
    await connection.query(`GRANT CONNECT,CREATE ON DATABASE ${database} TO ${migration}`);
    // All other logins remain unable to connect until reviewed provisioning.
    await connection.query(`COMMENT ON DATABASE ${database} IS '${deploymentDatabaseTag(config)}'`);
    for (const [key, value] of await logPrivacySettings()) {
      if (!["log_destination", "log_line_prefix"].includes(key)) {
        await connection.query(`ALTER DATABASE ${database} SET ${key} TO '${value}'`);
      }
    }
    await connection.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${migration} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
    return { initialized: true, environment: config.environment, roles: allRoleNames(config).length };
  });
}

export async function verifyMigrationConnection(pool, config) {
  await target(pool, config, { identity: "migration" });
  await verifyDatabaseLogging(pool);
  const role = (await pool.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS membership
    FROM pg_roles r WHERE rolname=current_user`)).rows[0];
  assert.ok(role && Object.values(role).every(value => value === false), "DEPLOYMENT_MIGRATION_IDENTITY_REJECTED");
}

/** Prisma receives only the separately verified non-superuser migration URL.
 * The bootstrap login is never used to execute historical migration SQL. */
export async function migrateDeploymentDatabase(connectionString, config) {
  assertDatabaseUrl(connectionString, config, "migration");
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await verifyMigrationConnection(pool, config);
    await runPrisma(["migrate", "deploy"], connectionString);
    await verifyDeploymentMigrations(pool);
    return { migrated: true, migrations: 8 };
  } catch (cause) { throw new Error("DEPLOYMENT_MIGRATION_REJECTED", { cause }); }
  finally { await pool.end(); }
}

export async function verifyDeploymentMigrations(connection) {
  const base = new URL("../../prisma/migrations/", import.meta.url);
  const names = (await readdir(base)).filter(name => /^\d{12}_/.test(name)).sort();
  assert.equal(names.length, 8, "DEPLOYMENT_MIGRATION_SET_REQUIRES_REVIEW");
  const records = (await connection.query(`SELECT migration_name,checksum,finished_at,rolled_back_at
    FROM public._prisma_migrations ORDER BY migration_name`)).rows;
  assert.equal(records.length, names.length);
  for (let index = 0; index < names.length; index++) {
    const row = records[index];
    assert.equal(row.migration_name, names[index]);
    assert.ok(row.finished_at && !row.rolled_back_at);
    assert.equal(row.checksum, createHash("sha256").update(await readFile(new URL(`${names[index]}/migration.sql`, base))).digest("hex"));
  }
}

async function columnInventory(connection) {
  return (await connection.query(`SELECT n.nspname,c.relname,a.attname,c.oid,a.attnum
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=ANY($1) AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY n.nspname,c.relname,a.attnum`, [schemas])).rows;
}

async function resetAndGrant(connection, role, inventory) {
  const name = quote(role.name);
  for (const schema of schemas) {
    await connection.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${name}`);
    await connection.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${name}`);
    await connection.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${name}`);
    await connection.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${name}`);
  }
  for (const table of new Set(inventory.map(row => `${row.nspname}.${row.relname}`))) {
    const cols = inventory.filter(row => `${row.nspname}.${row.relname}` === table).map(row => quote(row.attname)).join(",");
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
      await connection.query(`REVOKE ${privilege}(${cols}) ON ${tableSql(table)} FROM ${name}`);
    }
  }
  const neededSchemas = new Set(["public", ...Object.keys(role.tables).map(table => table.split(".")[0]),
    ...role.functions.map(signature => signature.split(".")[0]), ...(role.allTablesRead ? schemas : [])]);
  for (const schema of neededSchemas) await connection.query(`GRANT USAGE ON SCHEMA ${schema} TO ${name}`);
  if (role.allTablesRead) {
    for (const schema of schemas) await connection.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${name}`);
  }
  for (const [table, grants] of Object.entries(role.tables)) {
    for (const [privilege, cols] of Object.entries(grants)) {
      await connection.query(`GRANT ${privilege}${cols === "*" ? "" : `(${cols.map(quote).join(",")})`} ON ${tableSql(table)} TO ${name}`);
    }
  }
  for (const signature of role.functions) await connection.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${name}`);
}

/** Re-runnable grant installation under the separate bootstrap credential.
 * Unknown objects/roles and PUBLIC rights fail the subsequent exact audit.
 * All grants/owner changes commit together; no login can observe a half-policy. */
export async function provisionDeploymentDatabase(pool, config) {
  return transaction(pool, "DEPLOYMENT_PROVISION_REJECTED", async connection => {
    await target(connection, config, { bootstrap: true });
    await verifyDatabaseLogging(connection);
    await verifyDeploymentMigrations(connection);
    const inventory = await columnInventory(connection);
    for (const schema of schemas) {
      await connection.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await connection.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
      await connection.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
    }
    for (const role of deploymentPrivilegePolicy(config)) {
      await connection.query(`REVOKE ALL ON DATABASE ${quote(config.database.name)} FROM ${quote(role.name)}`);
      if (LOGIN_IDENTITIES.includes(role.key)) await connection.query(`GRANT CONNECT ON DATABASE ${quote(config.database.name)} TO ${quote(role.name)}`);
      await resetAndGrant(connection, role, inventory);
      if (role.ownFunction) {
        await connection.query(`GRANT CREATE ON SCHEMA public TO ${quote(role.name)}`);
        await connection.query(`ALTER FUNCTION ${role.ownFunction} OWNER TO ${quote(role.name)}`);
        await connection.query(`REVOKE CREATE ON SCHEMA public FROM ${quote(role.name)}`);
        await connection.query(`GRANT EXECUTE ON FUNCTION ${role.ownFunction} TO ${quote(role.name)}`);
      }
    }
    await auditPrivileges(connection, config);
    return { provisioned: true, securityDefiners: FUNCTION_IDENTITIES.length };
  });
}

async function auditPrivileges(connection, config) {
  const policy = deploymentPrivilegePolicy(config);
  const migration = (await connection.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication,
    EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS membership
    FROM pg_roles r WHERE rolname=$1`, [config.roles.migration])).rows[0];
  assert.ok(migration && Object.values(migration).every(value => value === false));
  const definers = (await connection.query(`SELECT p.oid,p.oid::regprocedure::text AS signature,p.proname,p.proconfig,
    r.rolname AS owner,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND p.prosecdef`)).rows;
  assert.equal(definers.length, FUNCTION_IDENTITIES.length);
  for (const [key, signature] of FUNCTION_IDENTITIES) {
    const name = signature.slice("public.".length).split("(")[0];
    const row = definers.find(item => item.proname === name);
    assert.ok(row && row.owner === config.roles.owners[key] && !row.public_execute);
    assert.deepEqual(row.proconfig, ["search_path=pg_catalog"]);
  }
  for (const role of policy) {
    const login = LOGIN_IDENTITIES.includes(role.key);
    const identity = (await connection.query(`SELECT r.oid,r.rolcanlogin,
      (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
       OR r.oid=(SELECT datdba FROM pg_database WHERE datname=current_database())
       OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid)
       OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid)
       OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
       OR has_database_privilege(r.oid,current_database(),'CREATE,TEMPORARY')
       OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
         AND has_schema_privilege(r.oid,n.oid,'CREATE'))) AS unsafe
      FROM pg_roles r WHERE rolname=$1`, [role.name])).rows[0];
    assert.ok(identity && identity.rolcanlogin === login && !identity.unsafe);
    const neededSchemas = new Set(["public", ...Object.keys(role.tables).map(table => table.split(".")[0]),
      ...role.functions.map(signature => signature.split(".")[0]), ...(role.allTablesRead ? schemas : [])]);
    for (const row of (await connection.query(`SELECT nspname,has_schema_privilege($1,oid,'USAGE') AS usage,
      has_schema_privilege($1,oid,'USAGE WITH GRANT OPTION,CREATE WITH GRANT OPTION') AS can_grant
      FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'`, [role.name])).rows) {
      assert.equal(row.usage, neededSchemas.has(row.nspname));
      assert.equal(row.can_grant, false);
    }
    const owned = (await connection.query(`SELECT p.oid::regprocedure::text AS signature FROM pg_proc p WHERE proowner=$1`, [identity.oid])).rows;
    assert.equal(owned.length, role.ownFunction ? 1 : 0);
    if (role.ownFunction) {
      assert.equal((await connection.query("SELECT $1::regprocedure::oid AS oid", [role.ownFunction])).rows[0].oid,
        definers.find(row => row.owner === role.name).oid);
    }
    const rows = (await connection.query(`SELECT n.nspname,c.relname,a.attname,
      has_column_privilege($1,c.oid,a.attnum,'SELECT') AS sel,
      has_column_privilege($1,c.oid,a.attnum,'INSERT') AS ins,
      has_column_privilege($1,c.oid,a.attnum,'UPDATE') AS upd,
      has_column_privilege($1,c.oid,a.attnum,'REFERENCES') AS refs,
      has_table_privilege($1,c.oid,'SELECT') AS table_select,
      has_table_privilege($1,c.oid,'INSERT') AS table_insert,
      has_table_privilege($1,c.oid,'UPDATE') AS table_update,
      has_table_privilege($1,c.oid,'DELETE') AS table_delete,
      has_table_privilege($1,c.oid,'TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS dangerous,
      (has_column_privilege($1,c.oid,a.attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION')
       OR has_table_privilege($1,c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION')) AS can_grant
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f')
        AND a.attnum>0 AND NOT a.attisdropped`, [role.name])).rows;
    for (const row of rows) {
      const expected = role.tables[`${row.nspname}.${row.relname}`] ?? {};
      for (const [privilege, actual] of [["SELECT", row.sel], ["INSERT", row.ins], ["UPDATE", row.upd]]) {
        assert.equal(actual, (role.allTablesRead && privilege === "SELECT" && schemas.includes(row.nspname))
          || expected[privilege] === "*" || (Array.isArray(expected[privilege]) && expected[privilege].includes(row.attname)));
      }
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        assert.equal(row[`table_${privilege.toLowerCase()}`], (role.allTablesRead && privilege === "SELECT" && schemas.includes(row.nspname))
          || expected[privilege] === "*");
      }
      assert.equal(row.refs || row.dangerous || row.can_grant, false);
    }
    assert.equal((await connection.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
        AND CASE WHEN c.relkind='S' THEN has_sequence_privilege($1,c.oid,'SELECT,UPDATE,USAGE') ELSE false END`, [role.name])).rows[0].n, 0);
    const functions = (await connection.query(`SELECT p.oid,p.oid::regprocedure::text AS signature,
      n.nspname||'.'||p.proname||'('||pg_catalog.oidvectortypes(p.proargtypes)||')' AS identity,
      has_function_privilege($1,p.oid,'EXECUTE') AS allowed,
      has_function_privilege($1,p.oid,'EXECUTE WITH GRANT OPTION') AS can_grant
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'`, [role.name])).rows;
    // Catalog identities do not require USAGE on private schemas. Casting an
    // hmac signature to regprocedure would wrongly require runtime key-schema
    // access merely to inspect another role's allowed function set.
    const allowed = [...role.functions, ...(role.ownFunction ? [role.ownFunction] : [])];
    const allowedOids = functions.filter(row => allowed.includes(row.identity.replaceAll(", ", ","))).map(row => row.oid);
    assert.equal(allowedOids.length, allowed.length);
    for (const row of functions) {
      assert.equal(row.allowed, allowedOids.includes(row.oid));
      assert.equal(row.can_grant, row.oid === definers.find(item => item.owner === role.name)?.oid);
    }
  }
  return { securityDefiners: definers.length, checkedIdentities: policy.length };
}

/** Uses only the runtime connection and catalog reads; never repairs grants or
 * obtains an operator credential. Startup must stop on failure. */
export async function auditRuntimeDatabase(pool, config) {
  try {
    await target(pool, config, { identity: "runtime" });
    await verifyDatabaseLogging(pool);
    return await auditPrivileges(pool, config);
  } catch (cause) { throw new Error("DEPLOYMENT_RUNTIME_PRIVILEGES_REJECTED", { cause }); }
}

export async function initializeDeploymentSigningKeys(pool, config, { publication, moderation }) {
  assert.match(publication ?? "", /^[a-f0-9]{64}$/);
  assert.match(moderation ?? "", /^[a-f0-9]{64}$/);
  assert.notEqual(publication, moderation);
  const first = Buffer.from(publication, "hex"), second = Buffer.from(moderation, "hex");
  try {
    return await transaction(pool, "DEPLOYMENT_KEY_INITIALIZATION_REJECTED", async connection => {
      await target(connection, config, { bootstrap: true });
      await verifyDatabaseLogging(connection);
      await auditPrivileges(connection, config);
      await connection.query("INSERT INTO mq_publish_private.signing_key(id,secret) VALUES(1,$1)", [first]);
      await connection.query("INSERT INTO mq_comment_private.moderation_key(id,secret) VALUES(1,$1)", [second]);
      return { initialized: true };
    });
  } finally { first.fill(0); second.fill(0); }
}
