import { createInterface } from "node:readline/promises";
import { createMediaBackup, verifyMediaBackup } from "./backup.mjs";
import { restoreMediaBackup } from "./restore.mjs";

// Explicit operator input only. No automatic .env/development database fallback,
// credentials in argv, unattended schedule or upload to any cloud service.
async function main() {
  const [operation, expectedDatabase, ...extra] = process.argv.slice(2);
  if (extra.length || !["backup", "verify", "restore"].includes(operation)
    || !/^[a-z][a-z0-9_]{2,62}$/.test(expectedDatabase ?? "")) throw new Error("INVALID_ARGUMENTS");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("TTY_REQUIRED");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Private archive: contains account/session data. Keep the service stopped; this command does not enable it.");
    if (await reader.question(`Type ${operation.toUpperCase()} ${expectedDatabase}: `) !== `${operation.toUpperCase()} ${expectedDatabase}`) {
      throw new Error("CONFIRMATION_FAILED");
    }
  } finally { reader.close(); }
  const tools = { container: process.env.MQ_PG_TOOLS_CONTAINER || undefined };
  if (operation === "backup") {
    const result = await createMediaBackup({ databaseURL: process.env.MQ_MEDIA_BACKUP_DATABASE_URL,
      expectedDatabase, backupParent: process.env.MQ_MEDIA_BACKUP_PARENT, tools,
      storage: { projectRoot: process.cwd(), roots: { development: process.env.MQ_MEDIA_DEVELOPMENT_ROOT,
        test: process.env.MQ_MEDIA_TEST_ROOT }, environment: process.env.MQ_MEDIA_ENV, maxVariantBytes: 4 * 1024 * 1024 } });
    console.log(`BACKUP_COMPLETE assets=${result.assets} files=${result.files}`);
    // A local operator needs the generated directory. No image/key/account data is printed.
    console.log(result.directory);
  } else if (operation === "verify") {
    const result = await verifyMediaBackup(process.env.MQ_MEDIA_BACKUP_DIRECTORY);
    if (result.sourceDatabase !== expectedDatabase) throw new Error("BACKUP_TARGET_REJECTED");
    console.log(`BACKUP_VERIFIED files=${result.files}`);
  } else {
    if (expectedDatabase !== "mq_test") throw new Error("RESTORE_TARGET_REJECTED");
    const result = await restoreMediaBackup({ directory: process.env.MQ_MEDIA_BACKUP_DIRECTORY,
      controlURL: process.env.MQ_MEDIA_RESTORE_CONTROL_URL, restoreParent: process.env.MQ_MEDIA_RESTORE_PARENT,
      projectRoot: process.cwd(), tools });
    console.log(`RESTORE_DRILL_COMPLETE database=${result.database} files=${result.files} serviceEnabled=false`);
    console.log(result.privateRoot);
  }
}

try { await main(); }
catch (error) {
  const safe = new Set(["INVALID_ARGUMENTS", "TTY_REQUIRED", "CONFIRMATION_FAILED", "BACKUP_BUSY", "BACKUP_FAILED",
    "RESTORE_FAILED", "BACKUP_TARGET_REJECTED", "RESTORE_TARGET_REJECTED", "BACKUP_INTEGRITY_FAILED"]);
  console.error(`MEDIA_BACKUP_${safe.has(error?.message) ? error.message : "FAILED"}; private details withheld`);
  process.exitCode = 1;
}
