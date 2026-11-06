import assert from "node:assert/strict";
import { URL } from "node:url";

export const FUNCTION_IDENTITIES = Object.freeze([
  ["grant_audit", "public.mq_admin_grant_audit()"],
  ["credential_lock", "public.mq_admin_credential_lock()"],
  ["credential_audit", "public.mq_admin_credential_audit()"],
  ["admin_access", "public.mq_lock_admin_access(text,text)"],
  ["admin_credentials", "public.mq_lock_admin_credentials(text)"],
  ["asset_projection", "public.mq_project_revision_assets()"],
  ["publication", "public.mq_apply_story_publication(text,bytea)"],
  ["like_access", "public.mq_lock_story_like_access(text,text,uuid)"],
  ["comment_context", "public.mq_lock_comment_context(text,text,uuid)"],
  ["comment_guard", "public.mq_guard_story_comment()"],
  ["moderation", "public.mq_apply_comment_moderation(text,bytea)"],
]);
export const LOGIN_IDENTITIES = Object.freeze(["migration", "runtime", "maintenance", "mediaMaintenance", "backup"]);

/** Manifest contains no credentials. Role names are derived, never arbitrary
 * operator-provided SQL identifiers. Development/test contracts are untouched. */
export function validateDeploymentConfig(value) {
  try {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    assert.equal(value.version, 1);
    assert.ok(["staging", "production"].includes(value.environment));
    assert.match(value.deploymentId ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    assert.ok(value.database && typeof value.database === "object");
    assert.deepEqual(Object.keys(value.database).sort(), ["host", "name", "port"]);
    assert.match(value.database.host ?? "", /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[::1\])$/);
    assert.ok(Number.isInteger(value.database.port) && value.database.port > 0 && value.database.port <= 65535);
    assert.match(value.database.name ?? "", value.environment === "production"
      ? /^mq_production$/ : /^mq_staging(?:_[a-f0-9]{32})?$/);
    assert.ok(!Object.hasOwn(value, "roles"));
    const prefix = `mq_${value.environment}_${value.deploymentId.replaceAll("-", "").slice(0, 8)}`;
    const roles = Object.fromEntries(LOGIN_IDENTITIES.map(name => [name,
      `${prefix}_${name === "mediaMaintenance" ? "media_maint" : name}`]));
    roles.owners = Object.fromEntries(FUNCTION_IDENTITIES.map(([key]) => [key, `${prefix}_${key}`]));
    return { ...value, database: { ...value.database }, roles };
  } catch { throw new Error("DEPLOYMENT_DATABASE_CONFIG_REJECTED"); }
}

export function assertDatabaseUrl(value, config, identity = "runtime") {
  try {
    const url = new URL(value);
    assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
    assert.equal(url.hostname, config.database.host);
    assert.equal(Number(url.port || 5432), config.database.port);
    assert.equal(url.pathname, `/${config.database.name}`);
    assert.ok(url.username && url.password && !url.search && !url.hash);
    assert.ok(!/[\r\n\0]/.test(decodeURIComponent(url.password)));
    if (identity !== "bootstrap") assert.equal(decodeURIComponent(url.username), config.roles[identity]);
    else assert.ok(!Object.values(config.roles).includes(decodeURIComponent(url.username)));
    return url;
  } catch { throw new Error("DEPLOYMENT_DATABASE_TARGET_REJECTED"); }
}

export const deploymentDatabaseTag = config => `mq-deployment-v1:${config.environment}:${config.deploymentId}`;
