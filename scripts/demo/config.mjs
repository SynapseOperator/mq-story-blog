import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function demoState(port = 3030) {
  return validateDemoState({ version: 1, deploymentId: randomUUID(), port });
}
export function validateDemoState(value) {
  assert.deepEqual(Object.keys(value).sort(), ["deploymentId", "port", "version"]);
  assert.equal(value.version, 1);
  assert.match(value.deploymentId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.ok(Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535);
  return value;
}
export const projectName = state => `mq-demo-${state.deploymentId.replaceAll("-", "")}`;
export const demoOrigin = state => `http://127.0.0.1:${state.port}`;
export function assertLocalDocker(contextEndpoint, env = {}) {
  // Docker's explicit context takes precedence over DOCKER_HOST. Match its
  // selection before any mutation, including shells carrying both variables.
  const endpoint = env.DOCKER_CONTEXT ? contextEndpoint : (env.DOCKER_HOST || contextEndpoint);
  assert.ok(endpoint.startsWith("unix:///") || endpoint.startsWith("npipe:////./pipe/"),
    "DEMO_REQUIRES_LOCAL_DOCKER: select a local Docker context; remote engines are not supported");
}
