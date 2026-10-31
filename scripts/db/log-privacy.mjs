import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const allowed = new Set([
  "log_destination", "log_error_verbosity", "log_min_messages", "log_min_error_statement",
  "log_parameter_max_length", "log_parameter_max_length_on_error", "log_statement",
  "log_min_duration_statement", "log_min_duration_sample", "log_transaction_sample_rate", "log_line_prefix",
]);
const serverOnly = new Set(["log_destination", "log_line_prefix"]);

export async function logPrivacySettings() {
  const text = await readFile(new URL("../../config/postgresql/log-privacy.conf", import.meta.url), "utf8");
  const settings = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([a-z_]+)\s*=\s*(.*?)\s*$/);
    assert.ok(match && allowed.has(match[1]), "Unexpected logging setting");
    const value = match[2].replace(/^'(.*)'$/, "$1");
    assert.match(value, /^[a-z0-9%[\] _-]+$/);
    settings.push([match[1], value]);
  }
  assert.equal(new Set(settings.map(([key]) => key)).size, allowed.size);
  return settings;
}

/** Called immediately after CREATE DATABASE by this run, before any migration.
 * Existing local databases/roles/server defaults are deliberately not changed.
 */
export async function configureTemporaryDatabaseLogging(control, name) {
  assert.match(name, /^mq_test_(auth|it|isolated|admin|public)_[a-f0-9]{32}$/);
  const destination = (await control.query("SHOW log_destination")).rows[0].log_destination;
  assert.equal(destination, "stderr", "Temporary DB privacy validation requires stderr logging");
  for (const [key, value] of await logPrivacySettings()) {
    if (!serverOnly.has(key)) await control.query(`ALTER DATABASE "${name}" SET ${key} TO '${value}'`);
  }
}

export async function verifyDatabaseLogging(pool, { server = false } = {}) {
  for (const [key, value] of await logPrivacySettings()) {
    if (key === "log_line_prefix" && !server) continue;
    const actual = (await pool.query("SELECT current_setting($1) AS value", [key])).rows[0].value;
    assert.equal(actual, value, `Effective ${key} must match the reviewed privacy policy`);
  }
}
