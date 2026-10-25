import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { databaseUrl } from "../db/environment.mjs";

try {
  const mode = process.argv[2];
  if (!["dev", "start"].includes(mode)) throw new Error("Invalid mode");
  const local = parseEnv(await readFile(new URL("../../.env.auth.local", import.meta.url), "utf8"));
  const origin = new URL(local.AUTH_ORIGIN);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.href !== `${origin.origin}/`) throw new Error("Invalid local origin");
  const database = await databaseUrl("dev", { localOnly: true });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url)), mode,
    "--hostname", "127.0.0.1", "--port", origin.port], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, ...local, DATABASE_URL: database }, stdio: "inherit",
  });
  child.on("error", () => { console.error("Local auth server failed to start; details omitted."); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} catch {
  console.error("Local auth setup unavailable. Follow docs/engineering/AUTHENTICATION.md; no credentials printed.");
  process.exitCode = 1;
}
