import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { validateDeploymentConfig, assertDatabaseUrl, FUNCTION_IDENTITIES, LOGIN_IDENTITIES } from "../scripts/production/database-config.mjs";
import { deploymentPrivilegePolicy } from "../scripts/production/database-policy.mjs";
import { validateDatabaseUrl } from "../scripts/db/environment.mjs";

const manifest = { version: 1, environment: "staging", deploymentId: "12345678-1234-1234-1234-123456789abc",
  database: { host: "postgres", port: 5432, name: "mq_staging" }, origin: "https://stories.example.test",
  media: { root: "/var/lib/mq/media", minFreeBytes: 268435456 } };

test("deployment targets derive fixed roles and exclude local development/test databases", () => {
  const config = validateDeploymentConfig(manifest);
  assert.equal(new Set([...LOGIN_IDENTITIES.map(key => config.roles[key]), ...Object.values(config.roles.owners)]).size, 16);
  for (const name of ["mq_test", "mq_development", "postgres", "mq_production"]) {
    assert.throws(() => validateDeploymentConfig({ ...manifest, database: { ...manifest.database, name } }));
  }
  for (const change of [{ version: 2 }, { environment: "dev" }, { deploymentId: "not-a-uuid" }, { roles: {} }]) {
    assert.throws(() => validateDeploymentConfig({ ...manifest, ...change }));
  }
  assert.throws(() => validateDeploymentConfig({ ...manifest, database: { ...manifest.database, extra: "unsafe" } }));
  const production = validateDeploymentConfig({ ...manifest, environment: "production", database: { ...manifest.database, name: "mq_production" } });
  assert.notEqual(production.roles.runtime, config.roles.runtime);
});

test("deployment URL boundary rejects other hosts, identities, databases and connection overrides", () => {
  const config = validateDeploymentConfig(manifest);
  const url = new URL(`postgresql://${config.roles.runtime}:synthetic-password@postgres:5432/mq_staging`);
  assert.equal(assertDatabaseUrl(url.href, config).hostname, "postgres");
  for (const mutate of [u => { u.hostname = "localhost"; }, u => { u.pathname = "/mq_test"; },
    u => { u.port = "5433"; }, u => { u.username = config.roles.migration; },
    u => { u.search = "?options=-c%20role%3Dpostgres"; }, u => { u.hash = "#unsafe"; },
    u => { u.password = ""; }, u => { u.password = "line%0Abreak"; }]) {
    const changed = new URL(url); mutate(changed); assert.throws(() => assertDatabaseUrl(changed.href, config));
  }
  assert.throws(() => validateDatabaseUrl(url.href, "test"));
  assert.throws(() => validateDatabaseUrl(url.href, "dev"));
});

test("reviewed production matrix gives each definer one owner and limits runtime writes", () => {
  const config = validateDeploymentConfig(manifest), policy = deploymentPrivilegePolicy(config);
  assert.equal(policy.length, 15);
  assert.deepEqual(policy.filter(role => role.ownFunction).map(role => role.ownFunction).sort(), FUNCTION_IDENTITIES.map(([, signature]) => signature).sort());
  const runtime = policy.find(role => role.key === "runtime");
  assert.deepEqual(runtime.tables["public.story"].UPDATE, ["draft_revision_id", "version", "updated_at"]);
  assert.deepEqual(runtime.tables["public.story_comment"].INSERT, ["id", "story_id", "user_id", "body", "submission_key_hash"]);
  assert.equal(runtime.tables["public.story_comment"].UPDATE, undefined);
  assert.equal(runtime.tables["public.AdminGrant"].UPDATE, undefined);
  assert.equal(runtime.tables["public.Account"].UPDATE, undefined);
  assert.equal(runtime.tables["mq_publish_private.signing_key"], undefined);
  assert.equal(runtime.tables["mq_comment_private.moderation_key"], undefined);
  assert.equal(runtime.functions.length, 6);
  assert.equal(policy.find(role => role.key === "backup").allTablesRead, true);
  assert.deepEqual(policy.find(role => role.key === "maintenance").functions, []);
});
