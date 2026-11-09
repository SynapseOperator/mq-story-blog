import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { runPrisma } from "../db/prisma-command.mjs";

/** A historical 001–008 database/client used only by the preserved negative
 * Spike and the forward-upgrade test. No production constraints are disabled. */
export async function prepareLegacySessionDatabase(connectionString) {
  const url = new URL(connectionString);
  assert.match(url.pathname, /^\/mq_test_[a-z_]*[a-f0-9]{32}$/);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const workspace = await mkdtemp(join(tmpdir(), "mq-legacy-session-"));
  const generatedParent = resolve(root, "src/generated/prisma");
  const generated = join(generatedParent, `legacy-session-${randomUUID()}`);
  let generatedCreated = false;
  const cleanup = async () => {
    // Both paths were created by this invocation. Never remove the parent client
    // tree or any unrelated temporary directory.
    assert.equal(dirname(resolve(generated)), generatedParent);
    if (generatedCreated) await rm(generated, { recursive: true });
    await rm(workspace, { recursive: true });
  };
  try {
    await mkdir(generated); generatedCreated = true;
    const migrations = join(workspace, "migrations"); await mkdir(migrations);
    const historical = (await readdir(join(root, "prisma/migrations")))
      .filter(name => /^\d{8}000[1-8]_/.test(name)).sort();
    assert.equal(historical.length, 8);
    for (const name of historical) {
      await mkdir(join(migrations, name));
      await copyFile(join(root, "prisma/migrations", name, "migration.sql"), join(migrations, name, "migration.sql"), 1);
    }
    await copyFile(join(root, "prisma/migrations/migration_lock.toml"), join(migrations, "migration_lock.toml"), 1);
    const currentSchema = await readFile(join(root, "prisma/schema.prisma"), "utf8");
    assert.equal((currentSchema.match(/^\s*tokenCiphertext\s+String.*$/gm) ?? []).length, 1);
    const schema = currentSchema.replace(/^\s*tokenCiphertext\s+String.*\r?\n/m, "")
      .replace(/output\s*=\s*"[^"]+"/, `output = ${JSON.stringify(generated.replaceAll("\\", "/"))}`);
    const schemaPath = join(workspace, "schema.prisma"), config = join(workspace, "prisma.config.ts");
    await writeFile(schemaPath, schema, { flag: "wx" });
    await writeFile(config, `export default { schema: ${JSON.stringify(schemaPath)}, migrations: { path: ${JSON.stringify(migrations)} }, datasource: { url: process.env.DATABASE_URL } };\n`, { flag: "wx" });
    await runPrisma(["generate", "--config", config], connectionString);
    await runPrisma(["migrate", "deploy", "--config", config], connectionString);
    const { PrismaClient } = await import(pathToFileURL(join(generated, "client.ts")).href);
    return { PrismaClient, cleanup };
  } catch (error) {
    await cleanup(); throw error;
  }
}
