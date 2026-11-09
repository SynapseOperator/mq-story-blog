import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";

// Deliberately separate from .env.db.local; never regenerate database credentials.
const file = new URL("../../.env.auth.local", import.meta.url);
const source = [
  "# Local-only authentication. Never commit this file or use it for deployment.",
  "MQ_AUTH_ENABLED=true", "AUTH_ORIGIN=http://127.0.0.1:3000", "AUTH_ALLOW_LOCAL_HTTP=true",
  `AUTH_SECRET=${randomBytes(48).toString("base64url")}`,
  `SESSION_STORAGE_KEY=${randomBytes(32).toString("hex")}`, "",
].join("\n");
try {
  await writeFile(file, source, { flag: "wx", mode: 0o600 });
  console.log("Created ignored .env.auth.local; existing database credentials were not read or changed.");
} catch (error) {
  console.error(error.code === "EEXIST" ? "Existing .env.auth.local preserved; no changes made." : "Authentication environment creation failed; details omitted.");
  process.exitCode = 1;
}
