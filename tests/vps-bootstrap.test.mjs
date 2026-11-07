import test from "node:test";
import assert from "node:assert/strict";
import { validateBootstrapTarget, assertIsolatedCompose, initializeLab } from "../scripts/production/vps-bootstrap.mjs";

const target = { directory: "/srv/mq-labs/p501-11111111-1111-4111-8111-111111111111", httpPort: 18080, httpsPort: 18443 };
test("VPS bootstrap accepts only an explicit fresh staging namespace and separate high ports", () => {
  assert.equal(validateBootstrapTarget(target).project, "mq-p501-11111111111141118111111111111111");
  for (const directory of ["/srv/mq", "/srv/mq-labs/production", `${target.directory}/../elsewhere`, `${target.directory}/`, "/tmp/p501-11111111-1111-4111-8111-111111111111"])
    assert.throws(() => validateBootstrapTarget({ ...target, directory }), /TARGET_REJECTED/);
  for (const httpPort of [22, 80, 443, 65536, 18443, NaN, 1024.5])
    assert.throws(() => validateBootstrapTarget({ ...target, httpPort }), /PORT_REJECTED/);
});

function composeFixture() {
  const state = { ...validateBootstrapTarget(target), images: { app: "sha256:a", tools: "sha256:t", proxy: "sha256:p" },
    manifest: { origin: "https://mq.localhost:18443" } };
  const spec = { name: state.project, services: {
    app: { image: state.images.app, user: "10001:10001", read_only: true, mem_limit: 1536 * 1024 ** 2,
      environment: { MQ_DEPLOYMENT_ENV: "staging", AUTH_ORIGIN: state.manifest.origin } },
    tools: { image: state.images.tools, user: "10001:10001", read_only: true },
    postgres: { image: `postgres:18.6-bookworm@sha256:${"a".repeat(64)}`, mem_limit: 768 * 1024 ** 2 },
    proxy: { image: state.images.proxy, user: "10001:10001", read_only: true, environment: { MQ_TLS_MODE: "local" },
      ports: [{ host_ip: "127.0.0.1", published: "18080", target: 80 }, { host_ip: "127.0.0.1", published: "18443", target: 443 }] },
  }, networks: { frontend: { internal: true }, database: { internal: true } } };
  return { state, spec };
}
test("rendered Compose must retain exact images, low identities and loopback-only ingress", () => {
  const { spec, state } = composeFixture(); assertIsolatedCompose(spec, state);
  const encodedBytes = JSON.parse(JSON.stringify(spec));
  for (const name of ["app", "postgres"]) encodedBytes.services[name].mem_limit = String(encodedBytes.services[name].mem_limit);
  assertIsolatedCompose(encodedBytes, state);
  for (const mutate of [
    s => { s.services.proxy.ports[0].host_ip = "0.0.0.0"; },
    s => { s.services.app.ports = [{ target: 3000, published: "3000" }]; },
    s => { s.services.postgres.ports = [{ target: 5432, published: "5432" }]; },
    s => { s.services.tools.user = "0:0"; }, s => { s.services.app.image = "unreviewed:latest"; },
    s => { s.services.proxy.environment.MQ_TLS_MODE = "public"; },
    s => { s.services.app.environment.MQ_DEPLOYMENT_ENV = "production"; },
    s => { s.networks.database.internal = false; },
    s => { s.services.postgres.mem_limit = 2 * 1024 ** 3; },
  ]) { const changed = JSON.parse(JSON.stringify(spec)); mutate(changed); assert.throws(() => assertIsolatedCompose(changed, state)); }
});

function executionFixture(fault) {
  const calls = [];
  return { calls, ctx: {
    compose: args => { calls.push(["compose", ...args]); if (fault?.("compose", args)) throw new Error("private child output"); },
    operation: (...args) => { calls.push(["operation", ...args]); if (fault?.("operation", args)) throw new Error("private child output"); },
  } };
}
test("fresh initialization uses all existing CLI identity boundaries in the documented order", async () => {
  const { ctx, calls } = executionFixture();
  await initializeLab(ctx, async () => { calls.push(["health"]); return true; });
  assert.deepEqual(calls.filter(call => call[0] === "operation").map(call => call.slice(1, 3)), [
    ["bootstrap", "bootstrap-secrets"], ["migrate", "migration-secrets"], ["provision", "bootstrap-secrets"],
    ["keys", "key-secrets"], ["audit", "app-secrets"], ["media-init", "maintenance-secrets"], ["admin-init", "maintenance-secrets"],
  ]);
  assert.deepEqual(calls[0], ["compose", "up", "-d", "--wait", "--wait-timeout", "180", "postgres"]);
  assert.equal(calls.at(-1)[0], "health");
  assert.equal(calls.some(call => call.includes("down") || call.includes("-v") || call.includes("reset")), false);
  assert.equal(calls.some(call => call.includes("currentRelease") || call.includes("backupReceipt")), false);
  const audit = calls.find(call => call[1] === "audit");
  assert.deepEqual(audit[3], { RUNTIME_DATABASE_URL_FILE: "/run/secrets/database_url" });
});
test("migration failure stops only own app and proxy; no continuation, deletion or raw error", async () => {
  const { ctx, calls } = executionFixture((kind, args) => kind === "operation" && args[0] === "migrate");
  await assert.rejects(initializeLab(ctx, async () => true), /^Error: VPS_LAB_FAILED_INGRESS_CLOSED$/);
  assert.deepEqual(calls.slice(-2), [["compose", "stop", "proxy"], ["compose", "stop", "app"]]);
  assert.equal(calls.some(call => call[1] === "provision"), false);
});
test("failed HTTPS never reports healthy, and containment failure is reported distinctly", async () => {
  const fixture = executionFixture();
  await assert.rejects(initializeLab(fixture.ctx, async () => false), /VPS_LAB_FAILED_INGRESS_CLOSED/);
  assert.deepEqual(fixture.calls.slice(-2), [["compose", "stop", "proxy"], ["compose", "stop", "app"]]);
  const broken = executionFixture((kind, args) => kind === "compose" && args[0] === "stop");
  await assert.rejects(initializeLab(broken.ctx, async () => false), /VPS_LAB_FAILED_CONTAINMENT_UNCONFIRMED/);
});
