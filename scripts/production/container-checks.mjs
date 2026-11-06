import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

/** Exercise the built Linux images, including modules that Next does not run
 * during its build. No deployment credentials or external network are used. */
export function runImageConfigurationChecks({ appImage, toolsImage, proxyImage }) {
  const docker = (args, expected = 0, env = process.env) => {
    const result = spawnSync("docker", args, { env, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined, "CONTAINER_CHECK_DOCKER_FAILED");
    assert.equal(result.status, expected, `CONTAINER_CHECK_FAILED: ${args[0]}`);
    return result;
  };
  const isolated = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true"];
  const compose = JSON.parse(docker(["compose", "--file", fileURLToPath(new URL("../../compose.production.yaml", import.meta.url)),
    "--profile", "maintenance", "config", "--format", "json"], 0, {
    ...process.env, MQ_DEPLOYMENT_ENV: "staging", MQ_DATABASE_NAME: "mq_staging_synthetic",
    MQ_APP_IMAGE: appImage, MQ_TOOLS_IMAGE: toolsImage, MQ_PROXY_IMAGE: proxyImage,
    MQ_AUTH_ORIGIN: "https://synthetic.localhost", MQ_PUBLIC_HOST: "synthetic.localhost",
    MQ_DEPLOYMENT_CONFIG: join(tmpdir(), "mq-container-config", "deployment.json"),
    MQ_SECRET_DIRECTORY: join(tmpdir(), "mq-container-config", "secrets"),
    MQ_AUTH_ENABLED: "false", MQ_MEDIA_ENABLED: "false", MQ_PUBLISH_ENABLED: "false", MQ_COMMENTS_ENABLED: "false",
  }).stdout);
  for (const [service, count] of [["app", 2], ["tools", 1], ["proxy", 1]]) {
    const mounts = compose.services[service].tmpfs;
    assert.equal(mounts.length, count, `CONTAINER_CHECK_TMPFS_COUNT: ${service}`);
    assert.ok(mounts.every(mount => mount.startsWith("/") && mount.includes("uid=10001,gid=10001,mode=0700")));
    assert.equal(compose.services[service].user, "10001:10001");
    assert.equal(compose.services[service].read_only, true);
    const probe = `for directory in "$@"; do
      test "$(stat -c %u:%g:%a "$directory")" = "10001:10001:700"
      touch "$directory/mq-tmpfs-probe"
    done`;
    docker([...isolated, ...mounts.flatMap(mount => ["--tmpfs", mount]), "--entrypoint", "/bin/sh",
      compose.services[service].image, "-eu", "-c", probe, "mq-tmpfs-probe", ...mounts.map(mount => mount.split(":")[0])]);
  }
  assert.deepEqual(Object.keys(compose.services).filter(name => compose.services[name].ports?.length), ["proxy"]);
  assert.ok(!compose.services.tools.secrets);
  assert.equal(compose.services["volumes-init"].network_mode, "none");
  assert.ok(!compose.services["volumes-init"].secrets);
  for (const network of ["frontend", "database"]) assert.equal(compose.networks[network].internal, true);
  for (const image of [appImage, toolsImage, proxyImage]) {
    const data = JSON.parse(docker(["image", "inspect", image]).stdout)[0];
    assert.equal(data.Config.User, "10001:10001");
    assert.ok(!data.Config.Env.some(value => /^(DATABASE_URL|AUTH_SECRET|AUTH_PROXY_SECRET|MQ_.*SIGNING_KEY)=/.test(value)));
  }
  const missingConfig = docker([...isolated, appImage], 1);
  assert.equal(missingConfig.stderr.trim(), "MQ_STARTUP_REJECTED");
  const missingProxyConfig = docker([...isolated, proxyImage], 1);
  assert.equal(missingProxyConfig.stderr.trim(), "MQ_PROXY_CONFIGURATION_REJECTED");
  const imageCode = `
    import assert from 'node:assert/strict';
    import sharp from 'sharp';
    import pg from 'pg';
    import { access } from 'node:fs/promises';
    import { decodeMedia } from './scripts/media/image-worker.mjs';
    import { logPrivacySettings } from './scripts/db/log-privacy.mjs';
    import { auditRuntimeDatabase } from './scripts/production/database.mjs';
    assert.equal(process.getuid(), 10001);
    assert.equal(process.versions.node, '24.19.0');
    assert.equal(typeof pg.Pool, 'function');
    assert.equal(typeof auditRuntimeDatabase, 'function');
    assert.equal((await logPrivacySettings()).length, 11);
    await access('./server.js');
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
    const result = await decodeMedia(png);
    assert.equal(result.display.mimeType, 'image/webp');
    assert.equal(result.display.width, 2);
    assert.equal(result.thumbnail.height, 2);
    console.log('STANDALONE_NATIVE_MODULES_OK');
  `;
  assert.equal(docker([...isolated, "--entrypoint", "node", appImage,
    "--input-type=module", "--eval", imageCode]).stdout.trim(), "STANDALONE_NATIVE_MODULES_OK");
  assert.equal(docker([...isolated, "--entrypoint", "npm", toolsImage, "--version"]).stdout.trim(), "11.17.0");

  const caddy = [...isolated,
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m,uid=10001,gid=10001,mode=0700",
    "--tmpfs", "/data:rw,noexec,nosuid,size=16m,uid=10001,gid=10001,mode=0700",
    "--tmpfs", "/config:rw,noexec,nosuid,size=16m,uid=10001,gid=10001,mode=0700",
    "--entrypoint", "caddy"];
  for (const [file, host] of [["Caddyfile", "synthetic.example.com"], ["Caddyfile.local", "synthetic.localhost"]]) {
    const args = [...caddy, "--env", `MQ_PUBLIC_HOST=${host}`, proxyImage];
    docker([...args, "validate", "--config", `/etc/caddy/${file}`, "--adapter", "caddyfile"]);
    const config = JSON.parse(docker([...args, "adapt", "--config", `/etc/caddy/${file}`, "--adapter", "caddyfile"]).stdout);
    assert.equal(config.admin.disabled, true);
    const server = Object.values(config.apps.http.servers)[0];
    assert.equal(server.strict_sni_host, true);
    assert.deepEqual(server.protocols, ["h1", "h2"]);
    const routes = server.routes[0].handle[0].routes;
    const handlers = routes.flatMap(route => route.handle);
    const proxyIndex = handlers.findIndex(handler => handler.handler === "reverse_proxy");
    const stripIndex = handlers.findIndex(handler => handler.handler === "headers" && handler.request?.delete?.includes("X-Mq-*"));
    assert.ok(stripIndex >= 0 && stripIndex < proxyIndex);
    const request = handlers[proxyIndex].headers.request;
    assert.ok(!request.delete?.includes("X-Mq-*"));
    assert.deepEqual(request.set["X-Mq-Proxy-Key"], ["{env.MQ_PROXY_SECRET}"]);
    assert.deepEqual(request.set["X-Mq-Client-Ip"], ["{http.request.remote.host}"]);
    assert.deepEqual(handlers.filter(handler => handler.handler === "request_body").map(handler => handler.max_size).sort((a, b) => a - b),
      [4096, 8192, 3145728]);
  }
  return { composeConfigurations: 1, composeTmpfsMounts: 4, imageUsers: 3, startupRejections: 2, nativeDecode: 1, caddyConfigurations: 2 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(runImageConfigurationChecks({
    appImage: process.env.MQ_APP_IMAGE ?? "mq-p302-app:local",
    toolsImage: process.env.MQ_TOOLS_IMAGE ?? "mq-p302-tools:local",
    proxyImage: process.env.MQ_PROXY_IMAGE ?? "mq-p302-proxy:local",
  })));
}
