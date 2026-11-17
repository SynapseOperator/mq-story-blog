import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoState, validateDemoState, demoOrigin, projectName, assertLocalDocker } from "../scripts/demo/config.mjs";
import { readState, showCredentials } from "../scripts/demo/cli.mjs";

test("local demo identity is random, persistent and cannot address the production project", async () => {
  const first = demoState(), second = demoState(3031);
  assert.notEqual(projectName(first), projectName(second));
  assert.match(projectName(first), /^mq-demo-[a-f0-9]{32}$/);
  assert.equal(demoOrigin(first), "http://127.0.0.1:3030");
  const path = join(await mkdtemp(join(tmpdir(), "mq-demo-test-")), "state.json");
  await writeFile(path, JSON.stringify(first));
  assert.deepEqual(await readState(path), first);
  for (const bad of [{ ...first, port: 443 }, { ...first, deploymentId: "production" }, { ...first, project: "mq-production" }]) {
    assert.throws(() => validateDemoState(bad));
  }
});

test("local demo rejects remote Docker endpoints before any Docker mutation", () => {
  for (const endpoint of ["unix:///var/run/docker.sock", "npipe:////./pipe/dockerDesktopLinuxEngine"]) assert.doesNotThrow(() => assertLocalDocker(endpoint));
  for (const endpoint of ["ssh://operator@server", "tcp://127.0.0.1:2376", "tcp://server:2375", ""]) assert.throws(() => assertLocalDocker(endpoint), /DEMO_REQUIRES_LOCAL_DOCKER/);
  assert.throws(() => assertLocalDocker("ssh://operator@server", { DOCKER_CONTEXT: "remote", DOCKER_HOST: "unix:///var/run/docker.sock" }), /DEMO_REQUIRES_LOCAL_DOCKER/);
  assert.doesNotThrow(() => assertLocalDocker("unix:///var/run/docker.sock", { DOCKER_CONTEXT: "local", DOCKER_HOST: "ssh://operator@server" }));
  assert.throws(() => assertLocalDocker("unix:///var/run/docker.sock", { DOCKER_HOST: "ssh://operator@server" }), /DEMO_REQUIRES_LOCAL_DOCKER/);
});

test("credentials cannot be written to a noninteractive log or CI artifact", async () => {
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  let invoked = false;
  await assert.rejects(showCredentials(async () => { invoked = true; return "{}"; }), /DEMO_CREDENTIALS_REQUIRE_INTERACTIVE_TERMINAL/);
  assert.equal(invoked, false);
});
