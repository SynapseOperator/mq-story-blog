import assert from "node:assert/strict";
import { verifyDatabaseLogging } from "../db/log-privacy.mjs";
import { COMMENT_PRIVILEGE_AUDIT_SQL, assertCommentPrivilegeRows } from "../../src/server/comments/privileges.ts";

const identifier = value => {
  assert.match(value ?? "", /^[a-z][a-z0-9_]{2,62}$/, "Invalid comment identity");
  return `"${value}"`;
};

/** After administrator provisioning, only in the named random test database.
 * No role creation, production grants, application startup hook or shared key. */
export async function applyCommentDatabasePrivileges(pool, { runtimeRole, commentOwnerRole, expectedDatabase }) {
  assert.match(expectedDatabase ?? "", /^mq_test_admin_[a-f0-9]{32}$/);
  const runtime = identifier(runtimeRole), owner = identifier(commentOwnerRole);
  assert.notEqual(runtimeRole, commentOwnerRole);
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const context = (await connection.query(`SELECT current_database() AS db,current_user AS actor,
      (SELECT datdba FROM pg_database WHERE datname=current_database()) AS database_owner`)).rows[0];
    assert.equal(context.db, expectedDatabase);
    for (const [name, login] of [[runtimeRole, true], [commentOwnerRole, false]]) {
      assert.notEqual(context.actor, name);
      const role = (await connection.query(`SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication
        FROM pg_roles WHERE rolname=$1`, [name])).rows[0];
      assert.ok(role && role.rolcanlogin === login && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole
        && !role.rolbypassrls && !role.rolreplication && role.oid !== context.database_owner);
      assert.equal((await connection.query("SELECT count(*)::int AS n FROM pg_auth_members WHERE member=$1", [role.oid])).rows[0].n, 0);
      assert.equal((await connection.query(`SELECT count(*)::int AS n FROM (
        SELECT oid FROM pg_class WHERE relowner=$1 UNION ALL SELECT oid FROM pg_namespace WHERE nspowner=$1
        UNION ALL SELECT oid FROM pg_proc WHERE proowner=$1 AND oid<>'public.mq_apply_comment_moderation(text,bytea)'::regprocedure
      ) owned`, [role.oid])).rows[0].n, 0);
      assert.equal((await connection.query(`SELECT has_database_privilege($1,current_database(),'CREATE,TEMPORARY')
        OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
          AND has_schema_privilege($1,oid,'CREATE')) AS unsafe`, [name])).rows[0].unsafe, false);
    }
    await connection.query(`REVOKE ALL ON public.story_comment FROM ${runtime}`);
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "REFERENCES"]) {
      await connection.query(`REVOKE ${privilege}(id,story_id,user_id,body,submission_key_hash,state,version,created_at,moderated_at,moderated_by,approved_at)
        ON public.story_comment FROM ${runtime}`);
    }
    await connection.query(`GRANT SELECT ON public.story_comment TO ${runtime}`);
    await connection.query(`GRANT INSERT(id,story_id,user_id,body,submission_key_hash) ON public.story_comment TO ${runtime}`);
    await connection.query(`GRANT EXECUTE ON FUNCTION public.mq_lock_comment_context(text,text,uuid) TO ${runtime}`);

    await connection.query(`GRANT USAGE ON SCHEMA public,mq_comment_private,mq_publish_private TO ${owner}`);
    await connection.query(`GRANT SELECT(id,story_id,state,version,approved_at) ON public.story_comment TO ${owner}`);
    await connection.query(`GRANT SELECT ON mq_comment_private.moderation_key TO ${owner}`);
    await connection.query(`GRANT UPDATE(state,version,moderated_at,moderated_by,approved_at) ON public.story_comment TO ${owner}`);
    await connection.query(`GRANT EXECUTE ON FUNCTION public.mq_lock_admin_access(text,text),
      public.mq_lock_comment_context(text,text,uuid),mq_publish_private.hmac(bytea,bytea,text) TO ${owner}`);
    await connection.query(`GRANT CREATE ON SCHEMA public TO ${owner}`);
    await connection.query(`ALTER FUNCTION public.mq_apply_comment_moderation(text,bytea) OWNER TO ${owner}`);
    await connection.query(`REVOKE CREATE ON SCHEMA public FROM ${owner}`);
    await connection.query("REVOKE ALL ON FUNCTION public.mq_apply_comment_moderation(text,bytea) FROM PUBLIC");
    await connection.query(`GRANT EXECUTE ON FUNCTION public.mq_apply_comment_moderation(text,bytea) TO ${runtime}`);
    await connection.query(`SET LOCAL ROLE ${runtime}`);
    assertCommentPrivilegeRows((await connection.query(COMMENT_PRIVILEGE_AUDIT_SQL)).rows);
    await connection.query("RESET ROLE");
    const columns = (await connection.query(`SELECT n.nspname,c.relname,a.attname,
      has_column_privilege($1,c.oid,a.attnum,'SELECT') AS rd,
      has_column_privilege($1,c.oid,a.attnum,'INSERT') AS ins,
      has_column_privilege($1,c.oid,a.attnum,'UPDATE') AS upd,
      has_column_privilege($1,c.oid,a.attnum,'REFERENCES') AS refs,
      has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS broad
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname IN ('public','mq_publish_private','mq_comment_private') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`, [commentOwnerRole])).rows;
    for (const column of columns) {
      assert.equal(column.rd, (column.relname === "story_comment" && ["id", "story_id", "state", "version", "approved_at"].includes(column.attname))
        || (column.nspname === "mq_comment_private" && column.relname === "moderation_key"));
      assert.equal(column.ins || column.refs || column.broad, false);
      assert.equal(column.upd, column.nspname === "public" && column.relname === "story_comment"
        && ["state", "version", "moderated_at", "moderated_by", "approved_at"].includes(column.attname));
    }
    assert.equal((await connection.query("SELECT has_function_privilege($1,'public.mq_apply_story_publication(text,bytea)','EXECUTE') AS allowed", [commentOwnerRole])).rows[0].allowed, false);
    assert.equal((await connection.query("SELECT pg_has_role($1,$2,'MEMBER') AS allowed", [runtimeRole, commentOwnerRole])).rows[0].allowed, false);
    const installed = (await connection.query(`SELECT p.prosecdef,p.proconfig,r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid='public.mq_apply_comment_moderation(text,bytea)'::regprocedure`)).rows[0];
    assert.equal(installed.rolname, commentOwnerRole); assert.equal(installed.prosecdef, true);
    assert.deepEqual(installed.proconfig, ["search_path=pg_catalog"]);
    await connection.query("COMMIT");
    return { runtimeRole, commentOwnerRole, expectedDatabase, productionProvisioned: false };
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    throw new Error("COMMENT_PRIVILEGE_SETUP_REJECTED");
  } finally { connection.release(); }
}

export async function initializeCommentKey(pool, { expectedDatabase, key }) {
  assert.match(expectedDatabase ?? "", /^mq_test_admin_[a-f0-9]{32}$/);
  assert.match(key ?? "", /^[a-f0-9]{64}$/);
  const bytes = Buffer.from(key, "hex"), connection = await pool.connect();
  try {
    await verifyDatabaseLogging(connection);
    await connection.query("BEGIN");
    assert.equal((await connection.query("SELECT current_database() AS db")).rows[0].db, expectedDatabase);
    await connection.query("INSERT INTO mq_comment_private.moderation_key(id,secret) VALUES(1,$1)", [bytes]);
    await connection.query("COMMIT");
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    throw new Error("COMMENT_KEY_INITIALIZATION_REJECTED");
  } finally { bytes.fill(0); connection.release(); }
}
