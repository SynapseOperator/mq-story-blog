import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { demoState, validateDemoState, projectName, demoOrigin, assertLocalDocker } from "./config.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function command(args, { env = process.env, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: repository, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    if (capture) { child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.resume(); }
    child.once("error", () => reject(new Error("DEMO_DOCKER_UNAVAILABLE")));
    child.once("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`DEMO_DOCKER_COMMAND_FAILED_${code}`)));
  });
}
export async function localDocker() {
  const contexts = JSON.parse(await command(["context", "inspect"], { capture: true }));
  assertLocalDocker(contexts[0]?.Endpoints?.docker?.Host || "", process.env);
  await command(["info", "--format", "{{.ServerVersion}}"], { capture: true });
}
export async function readState(path) {
  const metadata = await lstat(path);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), "DEMO_STATE_MUST_BE_REGULAR_FILE");
  return validateDemoState(JSON.parse(await readFile(path, "utf8")));
}
export function demoCompose(state, image) {
  assert.match(image, /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?$/);
  const env = { ...process.env, MQ_DEMO_ID: state.deploymentId, MQ_DEMO_SUFFIX: state.deploymentId.replaceAll("-", ""),
    MQ_DEMO_PORT: String(state.port), MQ_DEMO_TOOLS_IMAGE: image };
  return (args, options = {}) => command(["compose", "--project-name", projectName(state), "--file", "compose.demo.yaml", ...args], { ...options, env });
}
export async function startDemo({ statePath = join(repository, ".mq-demo.json"), image = process.env.MQ_DEMO_TOOLS_IMAGE, port = Number(process.env.MQ_DEMO_PORT ?? 3030) } = {}) {
  await localDocker();
  let state;
  try { state = await readState(statePath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = demoState(port); await writeFile(statePath, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  image ??= `${projectName(state)}:local`;
  if (!process.env.MQ_DEMO_TOOLS_IMAGE) await command(["build", "--target", "tools", "--tag", image, "."]);
  const compose = demoCompose(state, image);
  await compose(["run", "--rm", "--no-deps", "prepare"]);
  await compose(["up", "-d", "--wait", "postgres"]);
  await compose(["run", "--rm", "--no-deps", "initialize"]);
  await compose(["up", "-d", "--wait", "app"]);
  await compose(["run", "--rm", "--no-deps", "seed"]);
  console.log(`MQ local demo: ${demoOrigin(state)}\nAdmin: ${demoOrigin(state)}/admin/stories\nSynthetic data only. Local HTTP is not a production deployment.\nRun npm run demo:credentials in your terminal for the local accounts.\nStop with npm run demo:stop; data and passwords are retained.`);
  return { state, compose, image };
}
export async function showCredentials(compose) {
  assert.ok(process.stdin.isTTY && process.stdout.isTTY, "DEMO_CREDENTIALS_REQUIRE_INTERACTIVE_TERMINAL");
  const accounts = JSON.parse(await compose(["run", "--rm", "--no-deps", "initialize", "scripts/demo/credentials.mjs"], { capture: true }));
  for (const [role, account] of Object.entries(accounts)) console.log(`${role}: ${account.username}\nPassword (local demo only): ${account.password}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2] ?? "up";
    assert.ok(process.argv.length <= 3 && ["up", "stop", "status", "credentials"].includes(action), "DEMO_ARGUMENTS_REJECTED");
    if (action === "up") await startDemo();
    else {
      await localDocker();
      const state = await readState(join(repository, ".mq-demo.json"));
      const compose = demoCompose(state, process.env.MQ_DEMO_TOOLS_IMAGE ?? `${projectName(state)}:local`);
      if (action === "stop") { await compose(["stop", "app", "postgres"]); console.log("DEMO_STOPPED: named volumes and all data retained"); }
      else if (action === "status") await compose(["ps", "--all"]);
      else await showCredentials(compose);
    }
  } catch (error) {
    console.error(/^(?:DEMO_|MQ_)/.test(error.message) ? error.message.split("\n", 1)[0] : "DEMO_FAILED: check Docker Desktop and the local demo state; no automatic deletion");
    process.exitCode = 1;
  }
}
