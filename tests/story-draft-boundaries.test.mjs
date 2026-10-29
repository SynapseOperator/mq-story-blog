import assert from "node:assert/strict";
import test from "node:test";
import { mapStoryError, StoryDomainError } from "../src/server/stories/operations.ts";
import { createAdminDraftReader } from "../src/server/stories/admin-drafts.ts";
import { assertDraftPrivilegeRows } from "../src/server/stories/draft-privileges.ts";

test("draft error mapping preserves domain errors and only maps recognized database categories", () => {
  const conflict = new StoryDomainError("CONFLICT", "合成编辑冲突");
  assert.equal(mapStoryError(conflict), conflict);
  for (const error of [{ code: "P2002" }, { code: "P2034" }, { code: "P2010", meta: { code: "23505" } }]) {
    assert.equal(mapStoryError(error).code, "CONFLICT");
  }
  for (const error of [{ code: "P2003" }, { code: "P2004" }, { code: "P2010", meta: { code: "23503" } }]) {
    assert.equal(mapStoryError(error).code, "VALIDATION");
  }
  // Permission failures, disconnections and unexpected SQL faults must be
  // rejected as unavailable by the outer boundary, never downgraded to 400/409.
  for (const error of [new Error("synthetic-internal-failure"), { code: "P2010", meta: { code: "42501" } },
    { code: "P2010", meta: { code: "XX000" } }, { code: "P1001" }, null]) {
    assert.equal(mapStoryError(error), error);
  }
});

test("Prisma 7 pg raw-query wrapper maps unique/FK codes without exposing driver details", () => {
  const wrapped = originalCode => ({ code: "P2010", meta: { driverAdapterError: {
    name: "DriverAdapterError", cause: { originalCode, originalMessage: "SYNTHETIC_PRIVATE_DATABASE_DETAIL" },
  } } });
  const unique = mapStoryError(wrapped("23505"));
  assert.equal(unique.code, "CONFLICT");
  assert.equal(unique.cause, undefined);
  assert.equal(unique.meta, undefined);
  assert.ok(!unique.message.includes("SYNTHETIC_PRIVATE_DATABASE_DETAIL"));
  assert.equal(mapStoryError(wrapped("23503")).code, "VALIDATION");
  for (const code of ["42501", "08006", "XX000", undefined]) {
    const error = wrapped(code);
    assert.equal(mapStoryError(error), error);
  }
  const unrelated = { code: "P1001", meta: wrapped("23505").meta };
  assert.equal(mapStoryError(unrelated), unrelated);
});

test("private list rejects unsafe bounds and noncanonical cursors before issuing a query", async () => {
  const reader = createAdminDraftReader({ $queryRaw() { assert.fail("invalid input must not reach SQL"); } });
  for (const limit of [0, -1, 51, 1.5, NaN, Infinity, "20"]) {
    await assert.rejects(reader.list({ limit }), error => error instanceof StoryDomainError && error.code === "VALIDATION");
  }
  for (const cursor of [{ id: "invalid", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "01234567-89ab-cdef-0123-456789abcdef", createdAt: "2026-01-01" },
    { id: "01234567-89ab-cdef-0123-456789abcdef", createdAt: "-100000-01-01T00:00:00.000Z" },
    { id: "01234567-89ab-cdef-0123-456789abcdef", createdAt: "+010000-01-01T00:00:00.000Z" },
    { id: "01234567-89ab-cdef-0123-456789abcdef", createdAt: "0999-01-01T00:00:00.000Z" },
    { id: "01234567-89ab-cdef-0123-456789abcdef", createdAt: "invalid" }]) {
    await assert.rejects(reader.list({ cursor }), error => error instanceof StoryDomainError && error.code === "VALIDATION");
  }
  await assert.rejects(reader.get("invalid"), error => error instanceof StoryDomainError && error.code === "VALIDATION");
});

function restrictedRows() {
  const definitions = {
    story: { columns: ["id", "slug", "kind", "state", "slot_id", "draft_revision_id", "published_revision_id", "version", "created_at", "updated_at"],
      insert: ["id", "slug", "kind", "draft_revision_id"], update: ["draft_revision_id", "version", "updated_at"] },
    story_revision: { columns: ["id", "story_id", "title", "content", "created_at"], insert: ["id", "story_id", "title", "content"], update: [] },
    star_slot: { columns: ["id", "scene_key"], insert: [], update: [] },
  };
  return Object.entries(definitions).flatMap(([tableName, policy]) => policy.columns.map(columnName => ({
    tableName, columnName, canSelect: true, canInsert: policy.insert.includes(columnName),
    canUpdate: policy.update.includes(columnName), canReference: false, unsafeTable: false, canGrant: false,
  })));
}

test("draft runtime ACL rejects publication, identity and historical revision writes", () => {
  assert.doesNotThrow(() => assertDraftPrivilegeRows(restrictedRows()));
  for (const [table, column, privilege] of [
    ["story", "state", "canInsert"], ["story", "slot_id", "canInsert"], ["story", "published_revision_id", "canInsert"],
    ["story", "state", "canUpdate"], ["story", "slot_id", "canUpdate"], ["story", "published_revision_id", "canUpdate"],
    ["story", "slug", "canUpdate"], ["story", "kind", "canUpdate"], ["story_revision", "content", "canUpdate"],
    ["star_slot", "id", "canInsert"],
  ]) {
    const rows = restrictedRows();
    rows.find(row => row.tableName === table && row.columnName === column)[privilege] = true;
    assert.throws(() => assertDraftPrivilegeRows(rows), /ADMIN_DRAFT_DATABASE_PRIVILEGES_REJECTED/);
  }
});

test("draft runtime ACL fails closed on missing grants, table-wide authority and grant delegation", () => {
  for (const mutation of [
    rows => { rows[0].canSelect = false; }, rows => { rows[0].canInsert = false; },
    rows => { rows[0].unsafeTable = true; }, rows => { rows[0].canReference = true; },
    rows => { rows[0].canGrant = true; }, rows => { rows.splice(0, 10); },
  ]) {
    const rows = restrictedRows(); mutation(rows);
    assert.throws(() => assertDraftPrivilegeRows(rows), /ADMIN_DRAFT_DATABASE_PRIVILEGES_REJECTED/);
  }
  assert.throws(() => assertDraftPrivilegeRows([]), /ADMIN_DRAFT_DATABASE_PRIVILEGES_REJECTED/);
});
