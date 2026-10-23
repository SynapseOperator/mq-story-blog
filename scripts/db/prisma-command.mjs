import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const cli = fileURLToPath(new URL("../../node_modules/prisma/build/index.js", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));

// Capture CLI output, including failures: never relay a URL/password to logs.
export async function runPrisma(args, connectionString) {
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", () => reject(new Error("Prisma CLI could not start (details omitted)")));
    child.on("close", resolve);
  });
  if (status !== 0) throw new Error(`Prisma ${args.join(" ")} failed (exit ${status}); connection details omitted`);
}
