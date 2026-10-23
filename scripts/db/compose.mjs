import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Only lifecycle operations for this project's two databases; no volume deletion or raw flags. */
export function composeArguments(parameters) {
  const [operation, target = "all", ...extra] = parameters;
  const targets = { dev: ["postgres-dev"], test: ["postgres-test"], all: [] };
  if (extra.length || !Object.hasOwn(targets, target)) {
    throw new Error("Expected a target of dev, test or all; extra arguments are not accepted.");
  }
  const services = targets[target];
  const actions = {
    up: ["up", "--detach", "--wait", "--wait-timeout", "120", ...services],
    down: ["down"],
    stop: ["stop", ...services],
    start: ["start", "--wait", "--wait-timeout", "120", ...services],
    recreate: ["up", "--detach", "--wait", "--wait-timeout", "120", "--force-recreate", ...services],
  };
  if (!Object.hasOwn(actions, operation) || (operation === "down" && target !== "all")) {
    throw new Error("Usage: compose.mjs <up|down|stop|start|recreate> [dev|test|all]. down affects both services and preserves volumes.");
  }
  return ["compose", "--env-file", ".env.db.local", "--project-name", "mq-story-blog", "--file", "compose.yaml", ...actions[operation]];
}

export async function runCompose(parameters) {
  let argumentsList;
  try {
    argumentsList = composeArguments(parameters);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  let localEnvironment;
  try {
    localEnvironment = await readFile(new URL("../../.env.db.local", import.meta.url), "utf8");
  } catch {
    console.error("Missing or unreadable .env.db.local. Run npm run db:env first.");
    return 1;
  }
  const values = Object.fromEntries(localEnvironment.split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const secrets = Object.values(values).filter(Boolean).sort((left, right) => right.length - left.length);
  const result = spawnSync("docker", argumentsList, {
    cwd: projectRoot,
    // Explicitly prefer our local credentials over shell variables used for another database.
    env: { ...process.env, MQ_DEV_PASSWORD: values.MQ_DEV_PASSWORD, MQ_TEST_PASSWORD: values.MQ_TEST_PASSWORD },
    encoding: "utf8",
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const redact = (output) => secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), output ?? "");
  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));
  if (result.error) {
    console.error(result.error.code === "ENOENT"
      ? "Docker is unavailable. Install/enable it only after the environment setup is approved."
      : "Docker Compose could not complete. Check Docker availability and the local database ports.");
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCompose(process.argv.slice(2));
}
