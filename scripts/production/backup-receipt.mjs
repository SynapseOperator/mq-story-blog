import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { privatePath } from "../media/backup-files.mjs";

/** Only nonsecret backup receipt metadata crosses from tools UID10001 to the
 * root host coordinator. Secret-file ownership rules remain unchanged. */
export async function readBackupReceipt(path) {
  try {
    await privatePath(path, { directory: false });
    const handle = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const info = await handle.stat();
      assert.ok(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 4096);
      if (process.platform !== "win32") assert.ok([0, 10001, process.geteuid()].includes(info.uid) && (info.mode & 0o7777) === 0o600);
      const bytes = Buffer.alloc(info.size + 1); let count = 0;
      while (count < bytes.length) {
        const part = await handle.read(bytes, count, bytes.length - count, count);
        if (!part.bytesRead) break;
        count += part.bytesRead;
      }
      assert.equal(count, info.size);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
    } finally { await handle.close(); }
  } catch { throw new Error("BACKUP_WINDOW_RECEIPT_REJECTED"); }
}

