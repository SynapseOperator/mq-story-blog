import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

export const environmentPath = fileURLToPath(new URL("../../.env.db.local", import.meta.url));

/** Creates a new local environment atomically; never rotates an existing volume's password. */
export async function initializeDatabaseEnvironment(destination = environmentPath) {
  const developmentPassword = randomBytes(32).toString("hex");
  const testPassword = randomBytes(32).toString("hex");
  const content = [
    "# Generated local credentials. Never commit or print this file.",
    "# Existing PostgreSQL volumes retain their original password; do not regenerate casually.",
    `MQ_DEV_PASSWORD=${developmentPassword}`,
    `MQ_TEST_PASSWORD=${testPassword}`,
    `DEV_DATABASE_URL=postgresql://mq_dev:${developmentPassword}@127.0.0.1:55432/mq_development`,
    `TEST_DATABASE_URL=postgresql://mq_test:${testPassword}@127.0.0.1:55433/mq_test`,
    "",
  ].join("\n");
  await writeFile(destination, content, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await initializeDatabaseEnvironment();
    console.log("Created ignored .env.db.local with separate random development/test credentials.");
  } catch (error) {
    console.error(error?.code === "EEXIST"
      ? ".env.db.local already exists; kept unchanged. Reuse it with the existing database volumes."
      : "Could not create .env.db.local; check directory access. No credentials were printed.");
    process.exitCode = 1;
  }
}
