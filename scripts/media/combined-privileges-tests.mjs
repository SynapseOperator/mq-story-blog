import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDraftPrivilegeRows, DRAFT_PRIVILEGE_AUDIT_SQL } from "../../src/server/stories/draft-privileges.ts";

/** Baseline integration only: one restricted runtime identity must retain both
 * approved column policies. Positive mutations are rolled back before HTTP
 * fixtures run; no v2 rendering, asset selection or new production capability. */
export async function runCombinedMediaDraftPrivilegeTests({ runtime, runtimeRole, expectedDatabase }) {
  assert.match(expectedDatabase, /^mq_test_admin_[a-f0-9]{32}$/);
  assert.match(runtimeRole, /^mq_admin_rt_[a-f0-9]{32}$/);
  const identity = (await runtime.query("SELECT current_database() AS db,current_user AS role")).rows[0];
  assert.equal(identity.db, expectedDatabase); assert.equal(identity.role, runtimeRole);
  let passed = 0;
  assertDraftPrivilegeRows((await runtime.query(DRAFT_PRIVILEGE_AUDIT_SQL)).rows);
  const metadata = ["display_mime_type", "display_width", "display_height", "display_bytes", "display_sha256",
    "thumbnail_mime_type", "thumbnail_width", "thumbnail_height", "thumbnail_bytes", "thumbnail_sha256"];
  const columns = (await runtime.query(`SELECT attname,
    has_column_privilege(current_user,attrelid,attnum,'SELECT') AS sel,
    has_column_privilege(current_user,attrelid,attnum,'INSERT') AS ins,
    has_column_privilege(current_user,attrelid,attnum,'UPDATE') AS upd,
    has_column_privilege(current_user,attrelid,attnum,'REFERENCES') AS refs,
    has_column_privilege(current_user,attrelid,attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') AS grants
    FROM pg_attribute WHERE attrelid='public.media_asset'::regclass AND attnum>0 AND NOT attisdropped`)).rows;
  assert.ok(columns.length > metadata.length);
  for (const column of columns) {
    assert.equal(column.sel, true); assert.equal(column.ins, column.attname === "id");
    assert.equal(column.upd, ["state", ...metadata, "updated_at"].includes(column.attname));
    assert.equal(column.refs, false); assert.equal(column.grants, false);
  }
  assert.equal((await runtime.query(`SELECT has_table_privilege(current_user,'public.media_asset',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') AS unsafe`)).rows[0].unsafe, false);
  passed++; console.log("PASS combined privileges: one runtime satisfies both exact draft and media column matrices");

  const story = randomUUID(), first = randomUUID(), second = randomUUID(), asset = randomUUID();
  const connection = await runtime.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("INSERT INTO story(id,slug,kind,draft_revision_id) VALUES($1,$2,'STAR',$3)", [story, `baseline-${story}`, first]);
    for (const [revision, text] of [[first, "Synthetic initial baseline draft"], [second, "Synthetic baseline draft update"]]) {
      await connection.query("INSERT INTO story_revision(id,story_id,title,content) VALUES($1,$2,$3,$4::jsonb)",
        [revision, story, "Synthetic integration baseline", JSON.stringify({ version: 1, blocks: [{ type: "paragraph", text }] })]);
    }
    const saved = await connection.query("UPDATE story SET draft_revision_id=$1,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$2 AND version=0 RETURNING state,published_revision_id", [second, story]);
    assert.equal(saved.rowCount, 1); assert.equal(saved.rows[0].state, "DRAFT"); assert.equal(saved.rows[0].published_revision_id, null);
    await connection.query("INSERT INTO media_asset(id) VALUES($1)", [asset]);
    await connection.query(`UPDATE media_asset SET state='READY',display_mime_type='image/webp',display_width=20,display_height=10,
      display_bytes=40,display_sha256=repeat('a',64),thumbnail_mime_type='image/webp',thumbnail_width=20,thumbnail_height=10,
      thumbnail_bytes=40,thumbnail_sha256=repeat('b',64) WHERE id=$1`, [asset]);
    assert.equal((await connection.query("SELECT state FROM media_asset WHERE id=$1", [asset])).rows[0].state, "READY");
    assertDraftPrivilegeRows((await connection.query(DRAFT_PRIVILEGE_AUDIT_SQL)).rows);
    await connection.query("SET CONSTRAINTS ALL IMMEDIATE");
  } finally { await connection.query("ROLLBACK"); connection.release(); }
  for (const [table, id] of [["story", story], ["story_revision", first], ["story_revision", second], ["media_asset", asset]]) {
    assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id])).rows[0].n, 0);
  }
  passed++; console.log("PASS combined privileges: real draft creation/save and media finalization coexist and roll back together");

  for (const query of [
    "UPDATE story SET state='PUBLISHED' WHERE false", "UPDATE story SET published_revision_id=NULL WHERE false",
    "UPDATE story SET slot_id=NULL WHERE false", "UPDATE story_revision SET content='{}'::jsonb WHERE false",
    "UPDATE media_asset SET storage_key=gen_random_uuid() WHERE false", "DELETE FROM media_asset WHERE false",
    "UPDATE story_revision_asset SET asset_id=gen_random_uuid() WHERE false",
    "INSERT INTO story_revision_asset(revision_id,asset_id) VALUES(gen_random_uuid(),gen_random_uuid())",
    'UPDATE "AdminGrant" SET "revokedAt"=NULL WHERE false', "SELECT public.mq_project_revision_assets()",
  ]) {
    assert.equal(await runtime.query(query).then(() => "SUCCESS", error => error.code), "42501");
  }
  passed++; console.log("PASS combined privileges: direct SQL cannot publish, bind slots, alter history/references or escalate authority");
  return { passed, total: 3 };
}
