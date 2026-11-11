import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { assertProductionCompose } from "./production-host.mjs";

// Exercise the installed Compose CLI, which command doubles cannot validate.
// No credentials, database, published port or running container is needed.
const directory = await mkdtemp(join(tmpdir(), "mq-compose-probe-"));
const project = `mq-compose-probe-${randomUUID().replaceAll("-", "")}`;
const image = process.env.MQ_LAB_PROXY_IMAGE ?? "mq-p302-proxy:local";
const env = { ...process.env };
delete env.COMPOSE_PROFILES;
delete env.COMPOSE_FILE;
const images = Object.fromEntries(["app", "tools", "proxy"].map(name => [name, `synthetic/${name}@sha256:${"a".repeat(64)}`]));
Object.assign(env, { MQ_DEPLOYMENT_ENV: "production", MQ_DATABASE_NAME: "mq_production",
  MQ_AUTH_ORIGIN: "https://synthetic.example.invalid", MQ_PUBLIC_HOST: "synthetic.example.invalid",
  MQ_APP_IMAGE: images.app, MQ_TOOLS_IMAGE: images.tools, MQ_PROXY_IMAGE: images.proxy,
  MQ_DEPLOYMENT_CONFIG: join(directory, "unused-manifest.json"), MQ_SECRET_DIRECTORY: join(directory, "unused-secrets"),
  MQ_AUTH_ENABLED: "false", MQ_MEDIA_ENABLED: "false", MQ_PUBLISH_ENABLED: "false", MQ_COMMENTS_ENABLED: "false" });
let stage = "compose-version";
const docker = args => {
  const result = spawnSync("docker", args, { env, encoding: "utf8", windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
  assert.ok(!result.error && result.status === 0, "COMPOSE_PROBE_COMMAND_FAILED");
  return result.stdout.trim();
};
try {
  const version = docker(["compose", "version", "--short"]);
  await writeFile(join(directory, "empty.env"), "", { flag: "wx" });
  await writeFile(join(directory, "closed.yaml"), "services:\n  proxy:\n    ports: !reset []\n", { flag: "wx" });
  const base = ["compose", "--project-name", "mq-production", "--env-file", join(directory, "empty.env"),
    "-f", fileURLToPath(new URL("../../compose.production.yaml", import.meta.url)), "-f", join(directory, "closed.yaml")];
  stage = "production-config";
  const incomplete = JSON.parse(docker([...base, "config", "--format", "json"]));
  assert.equal(incomplete.services.tools, undefined);
  assert.throws(() => assertProductionCompose(incomplete, { images, config: { origin: env.MQ_AUTH_ORIGIN } }));
  const complete = JSON.parse(docker([...base, "--profile", "maintenance", "config", "--format", "json"]));
  assertProductionCompose(complete, { images, config: { origin: env.MQ_AUTH_ORIGIN } });

  stage = "isolated-fixture";
  docker(["image", "inspect", image, "--format", "{{.Id}}"]); // Must already exist; no pull/build.
  const service = { image, entrypoint: ["/bin/busybox"], command: ["true"], read_only: true,
    cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], mem_limit: "16m", pids_limit: 16 };
  const file = join(directory, "compose.json");
  await writeFile(file, JSON.stringify({ services: {
    postgres: { ...service, networks: ["database"] },
    app: { ...service, depends_on: ["postgres"], networks: ["frontend", "database"] },
    proxy: { ...service, depends_on: ["app"], networks: ["edge", "frontend"] },
  }, networks: { edge: {}, frontend: { internal: true }, database: { internal: true } } }), { flag: "wx" });
  const compose = ["compose", "--project-name", project, "--env-file", join(directory, "empty.env"), "-f", file];
  stage = "invalid-create-negative-control";
  const rejected = spawnSync("docker", [...compose, "create", "--no-deps", "proxy"],
    { env, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.ok(!rejected.error && rejected.status !== 0 && /unknown flag: --no-deps/.test(rejected.stderr), "OLD_COMMAND_NOT_REJECTED");
  assert.equal(docker([...compose, "ps", "--all", "--quiet"]), "");

  stage = "prepare-without-start";
  docker([...compose, "up", "--no-start", "--no-deps", "proxy"]);
  const ids = docker([...compose, "ps", "--all", "--quiet"]).split(/\s+/).filter(Boolean);
  assert.equal(ids.length, 1, "DEPENDENCY_WAS_CREATED");
  const [proxy] = JSON.parse(docker(["inspect", ...ids]));
  assert.equal(proxy.Config.Labels["com.docker.compose.project"], project);
  assert.equal(proxy.Config.Labels["com.docker.compose.service"], "proxy");
  assert.equal(proxy.State.Status, "created");
  assert.equal(proxy.State.Running, false);
  assert.ok(!proxy.State.StartedAt || proxy.State.StartedAt.startsWith("0001-01-01"), "PROXY_WAS_STARTED");
  assert.ok(Object.values(proxy.HostConfig.PortBindings ?? {}).every(value => !value?.length));
  stage = "inspect-created-networks";
  const networks = JSON.parse(docker(["network", "inspect", `${project}_edge`, `${project}_frontend`]));
  assert.equal(networks.length, 2);
  for (const network of networks) {
    assert.equal(network.Labels["com.docker.compose.project"], project);
    assert.equal(network.Driver, "bridge");
    assert.equal(network.Internal, network.Name.endsWith("_frontend"));
  }
  console.log(JSON.stringify({ composeVersion: version, maintenanceConfigValidated: true, ambientMaintenanceProfile: false,
    oldCreateExit: rejected.status, proxyCreatedWithoutStarting: true, dependenciesCreated: false,
    networksInspectedBeforeStart: true, publicPortsPublished: false, synthetic: true }));
} catch {
  console.error(`RELEASE_COMPOSE_PROBE_FAILED;stage=${stage}`);
  process.exitCode = 1;
} finally {
  // Only this random fixture's stopped containers/networks; never touch volumes
  // or the production project. Keep failed evidence if cleanup itself rejects.
  const ids = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]).split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const [container] = JSON.parse(docker(["inspect", id]));
    assert.equal(container.Config.Labels["com.docker.compose.project"], project);
    assert.equal(container.State.Running, false, "UNEXPECTED_RUNNING_FIXTURE");
    docker(["rm", id]);
  }
  const networks = docker(["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]).split(/\s+/).filter(Boolean);
  for (const network of networks) docker(["network", "rm", network]);
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("mq-compose-probe-"));
  await rm(directory, { recursive: true });
}
