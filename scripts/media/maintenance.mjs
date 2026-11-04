import { createHash } from "node:crypto";
import { MediaStorageError } from "../../src/server/media/local-store.ts";
import { beginMediaDeletion, finishMediaDeletion } from "../../src/server/media/lifecycle.ts";

const identifier = /^[a-z][a-z0-9_]{0,62}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseMediaMaintenanceArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!["--operation", "--database", "--asset-id"].includes(key) || Object.hasOwn(values, key)
      || !value || value.startsWith("--")) throw new Error("INVALID_ARGUMENTS");
    values[key] = value;
  }
  const operation = values["--operation"], database = values["--database"], id = values["--asset-id"];
  if (Object.keys(values).length !== 3 || !["diagnose", "recover"].includes(operation)
    || !identifier.test(database ?? "") || ["postgres", "template0", "template1"].includes(database)
    || !uuid.test(id ?? "")) throw new Error("INVALID_ARGUMENTS");
  return { operation, database, id };
}

/** Metadata and file hashes are reported without storage keys, absolute paths,
 * driver errors or file contents. This is a point-in-time diagnostic, not a lock. */
export async function diagnoseMediaAsset(db, store, id) {
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset) return { id, state: "NOT_FOUND", referenceCount: 0, display: "missing", thumbnail: "missing" };
  const report = { id, state: asset.state, referenceCount: await db.storyRevisionAsset.count({ where: { assetId: id } }) };
  for (const variant of ["display", "thumbnail"]) {
    try {
      const bytes = await store.read(asset.storageKey, variant);
      report[variant] = asset[`${variant}Sha256`] === null ? "untracked"
        : bytes.byteLength === asset[`${variant}Bytes`]
          && createHash("sha256").update(bytes).digest("hex") === asset[`${variant}Sha256`] ? "ok" : "mismatch";
    } catch (error) {
      report[variant] = error instanceof MediaStorageError && error.code === "NOT_FOUND" ? "missing" : "unsafe";
    }
  }
  return report;
}

/** The CLI requires a dedicated limited role and an explicit operator assertion
 * that all upload processes are stopped. No online worker or HTTP calls this. */
export async function recoverMediaAsset(db, store, id, { offlineConfirmed } = {}) {
  if (offlineConfirmed !== true) throw new Error("OFFLINE_CONFIRMATION_REQUIRED");
  const asset = await db.$transaction(tx => beginMediaDeletion(tx, id, { offline: true }));
  // DELETED tombstones may retain outputs after a process interruption. This
  // cleanup is still ID-scoped and refuses every unknown file before unlinking.
  await store.removeAsset(asset.storageKey);
  const result = await db.$transaction(tx => finishMediaDeletion(tx, id));
  return { id: result.id, state: result.state };
}
