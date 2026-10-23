import { databaseUrl } from "./environment.mjs";
import { runPrisma } from "./prisma-command.mjs";

try {
  const [action = "deploy", target = "dev", ...extra] = process.argv.slice(2);
  if (!["deploy", "status"].includes(action) || !["dev", "test"].includes(target) || extra.length) {
    throw new Error("Usage: migrate.mjs <deploy|status> <dev|test>");
  }
  await runPrisma(["migrate", action], await databaseUrl(target));
  console.log(`Prisma migrate ${action}: ${target} database OK`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
