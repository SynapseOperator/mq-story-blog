import assert from "node:assert/strict";
import { verifyDatabaseLogging } from "../db/log-privacy.mjs";

const identifier = value => {
  assert.match(value ?? "", /^[a-z][a-z0-9_]{2,62}$/, "Publishing identity is invalid");
  return `"${value}"`;
};

/** Only explicitly named random test databases are supported in P2-10A.
 * Production role/key provisioning needs a separate deployment review.
 * Call AFTER the existing administrator/draft/media provisioners. */
export async function applyPublishingDatabasePrivileges(pool, { runtimeRole, publicationOwnerRole, expectedDatabase }) {
  assert.match(expectedDatabase ?? "", /^mq_test_admin_[a-f0-9]{32}$/, "Publishing requires an isolated database");
  const runtime = identifier(runtimeRole), owner = identifier(publicationOwnerRole);
  assert.notEqual(runtimeRole, publicationOwnerRole);
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const context = (await connection.query(`SELECT current_database() AS db,current_user AS actor,
      (SELECT datdba FROM pg_database WHERE datname=current_database()) AS database_owner`)).rows[0];
    assert.equal(context.db, expectedDatabase);
    for (const [name, login] of [[runtimeRole, true], [publicationOwnerRole, false]]) {
      assert.notEqual(context.actor, name);
      const role = (await connection.query(`SELECT oid,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication
        FROM pg_roles WHERE rolname=$1`, [name])).rows[0];
      assert.ok(role && role.rolcanlogin === login && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole
        && !role.rolbypassrls && !role.rolreplication && role.oid !== context.database_owner);
      assert.equal((await connection.query("SELECT count(*)::int AS n FROM pg_auth_members WHERE member=$1", [role.oid])).rows[0].n, 0);
      assert.equal((await connection.query(`SELECT has_database_privilege($1,current_database(),'CREATE,TEMPORARY')
        OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'
          AND has_schema_privilege($1,oid,'CREATE')) AS unsafe`, [name])).rows[0].unsafe, false);
      const owned = (await connection.query(`SELECT count(*)::int AS n FROM (
        SELECT oid FROM pg_class WHERE relowner=$1 UNION ALL SELECT oid FROM pg_namespace WHERE nspowner=$1
        UNION ALL SELECT oid FROM pg_proc WHERE proowner=$1 AND oid<>'public.mq_apply_story_publication(text,bytea)'::regprocedure
      ) objects`, [role.oid])).rows[0].n;
      assert.equal(owned, 0);
    }
    // Grant only exact columns read/written by the fixed function. It does not
    // own tables, schema, authorization functions, or the crypto extension.
    await connection.query(`GRANT USAGE ON SCHEMA public,mq_publish_private TO ${owner}`);
    await connection.query(`GRANT SELECT ON public.story,public.story_revision,public.star_slot,
      public.media_asset,public.story_revision_asset,mq_publish_private.signing_key TO ${owner}`);
    await connection.query(`GRANT UPDATE (state,published_revision_id,slot_id,version,updated_at) ON public.story TO ${owner}`);
    await connection.query(`GRANT EXECUTE ON FUNCTION public.mq_lock_admin_access(text,text),
      mq_publish_private.hmac(bytea,bytea,text) TO ${owner}`);
    // ALTER OWNER needs CREATE on the containing schema, only during this
    // operator-owned transaction. Neither runtime nor maintenance joins owner.
    await connection.query(`GRANT CREATE ON SCHEMA public TO ${owner}`);
    await connection.query(`ALTER FUNCTION public.mq_apply_story_publication(text,bytea) OWNER TO ${owner}`);
    await connection.query(`REVOKE CREATE ON SCHEMA public FROM ${owner}`);
    await connection.query(`REVOKE ALL ON FUNCTION public.mq_apply_story_publication(text,bytea) FROM PUBLIC`);
    await connection.query(`GRANT EXECUTE ON FUNCTION public.mq_apply_story_publication(text,bytea) TO ${runtime}`);
    for (const column of ["state", "published_revision_id", "slot_id"]) {
      assert.equal((await connection.query("SELECT has_column_privilege($1,'public.story',$2,'INSERT,UPDATE') AS allowed",
        [runtimeRole, column])).rows[0].allowed, false);
    }
    assert.equal((await connection.query(`SELECT has_table_privilege($1,'mq_publish_private.signing_key','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
      OR has_any_column_privilege($1,'mq_publish_private.signing_key','SELECT,INSERT,UPDATE,REFERENCES') AS allowed`, [runtimeRole])).rows[0].allowed, false);
    assert.equal((await connection.query("SELECT has_schema_privilege($1,'mq_publish_private','USAGE,CREATE') AS allowed", [runtimeRole])).rows[0].allowed, false);
    assert.equal((await connection.query("SELECT pg_has_role($1,$2,'MEMBER') AS allowed", [runtimeRole, publicationOwnerRole])).rows[0].allowed, false);
    assert.equal((await connection.query(`SELECT has_schema_privilege($1,'public','CREATE')
      OR has_table_privilege($1,'public.story','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
      OR has_any_column_privilege($1,'public."AdminGrant"','INSERT,UPDATE')
      OR has_any_column_privilege($1,'mq_publish_private.signing_key','INSERT,UPDATE') AS unsafe`, [publicationOwnerRole])).rows[0].unsafe, false);
    const config = (await connection.query(`SELECT p.prosecdef,p.proconfig,r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid='public.mq_apply_story_publication(text,bytea)'::regprocedure`)).rows[0];
    assert.equal(config.rolname, publicationOwnerRole);
    assert.equal(config.prosecdef, true);
    assert.deepEqual(config.proconfig, ["search_path=pg_catalog"]);
    const columns = (await connection.query(`SELECT n.nspname,c.relname,a.attname,
      has_column_privilege($1,c.oid,a.attnum,'SELECT') AS rd,
      has_column_privilege($1,c.oid,a.attnum,'INSERT') AS ins,
      has_column_privilege($1,c.oid,a.attnum,'UPDATE') AS upd,
      has_column_privilege($1,c.oid,a.attnum,'REFERENCES') AS refs,
      has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS broad
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname IN ('public','mq_publish_private') AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`, [publicationOwnerRole])).rows;
    for (const column of columns) {
      const readable = ["story", "story_revision", "star_slot", "media_asset", "story_revision_asset", "signing_key"].includes(column.relname);
      assert.equal(column.rd, readable);
      assert.equal(column.ins || column.refs || column.broad, false);
      assert.equal(column.upd, column.nspname === "public" && column.relname === "story"
        && ["state", "published_revision_id", "slot_id", "version", "updated_at"].includes(column.attname));
    }
    await connection.query("COMMIT");
    return { runtimeRole, publicationOwnerRole, expectedDatabase, productionProvisioned: false };
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    throw new Error("PUBLISHING_PRIVILEGE_SETUP_REJECTED");
  } finally { connection.release(); }
}

/** One-time initialization; existing keys cannot be silently overwritten.
 * The caller owns the independent configuration credential. No startup hook. */
export async function initializePublishingKey(pool, { expectedDatabase, key }) {
  assert.match(expectedDatabase ?? "", /^mq_test_admin_[a-f0-9]{32}$/, "Publishing key requires an isolated database");
  assert.match(key ?? "", /^[0-9a-f]{64}$/, "Publishing key must be 32 independent random bytes");
  const connection = await pool.connect();
  const bytes = Buffer.from(key, "hex");
  try {
    await verifyDatabaseLogging(connection);
    await connection.query("BEGIN");
    const context = (await connection.query(`SELECT current_database() AS db,
      pg_has_role(current_user,(SELECT relowner FROM pg_class WHERE oid='mq_publish_private.signing_key'::regclass),'MEMBER') AS owner`)).rows[0];
    assert.equal(context.db, expectedDatabase);
    assert.equal(context.owner, true);
    await connection.query("INSERT INTO mq_publish_private.signing_key(id,secret) VALUES(1,$1)", [bytes]);
    await connection.query("COMMIT");
  } catch {
    await connection.query("ROLLBACK").catch(() => {});
    throw new Error("PUBLISHING_KEY_INITIALIZATION_REJECTED");
  } finally { bytes.fill(0); connection.release(); }
}
