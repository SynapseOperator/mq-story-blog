import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

export function assertTemporaryTarget(connectionString) {
  const url = new URL(connectionString);
  assert.match(url.pathname, /^\/mq_test_admin_[a-f0-9]{32}$/);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  return url;
}

// Do not persist responses, cookies, bodies or error objects. Secrets are only
// retained in memory for redaction assertions by the enclosing test runner.
export function transport(origin, secrets, ca) {
  const url = new URL(origin);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.protocol === "http:" || (url.protocol === "https:" && ca));
  return function request(path, { method = "GET", body, rawBody, jar, requestOrigin = origin, headers = {} } = {}) {
    const sent = { ...headers };
    if (requestOrigin !== null) sent.origin = requestOrigin;
    if (body !== undefined && !sent["content-type"]) sent["content-type"] = "application/json";
    if (jar?.cookie) sent.cookie = jar.cookie;
    return new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const outgoing = client.request(new URL(path, origin), { method, ca, headers: sent, timeout: 30_000 }, incoming => {
        let text = "";
        incoming.setEncoding("utf8");
        incoming.on("data", part => { text += part; });
        incoming.on("error", reject);
        incoming.on("end", () => {
          try {
            assert.ok(!text.includes("@accounts.invalid"), "Compatibility email must not reach a response");
            assert.ok(!/"(?:token|tokenCiphertext|email|emailVerified|password)"\s*:/.test(text), "Sensitive DTO field found");
            assert.ok([...secrets].every(secret => !secret || !text.includes(secret)), "Secret found in response");
            let data;
            try { data = JSON.parse(text); } catch { data = null; }
            const cookieLines = incoming.headers["set-cookie"] ?? [];
            for (const line of cookieLines) {
              if (!/^(?:__Secure-)?mq\.session_token=/.test(line) || /max-age=0(?:;|$)/i.test(line)) continue;
              const cookie = line.split(";", 1)[0];
              secrets.add(cookie); secrets.add(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)).split(".", 1)[0]);
            }
            if (jar) for (const line of cookieLines) {
              if (/^(?:__Secure-)?mq\.session_token=/.test(line)) {
                jar.cookie = /max-age=0(?:;|$)/i.test(line) ? "" : line.split(";", 1)[0];
              }
            }
            resolve({ status: incoming.statusCode, data, text, headers: incoming.headers, cookieLines });
          } catch { reject(new Error("Safe HTTP response assertion failed")); }
        });
      });
      outgoing.once("error", reject);
      outgoing.once("timeout", () => outgoing.destroy(new Error("Temporary draft HTTP request timed out")));
      outgoing.end(rawBody ?? (body === undefined ? undefined : JSON.stringify(body)));
    });
  };
}

export async function observeWait(pool, role, predicate = "wait_event='advisory'", minimum = 1) {
  // Poll an actual PostgreSQL lock state; the delay merely bounds observer load.
  // Callers release their barrier only after the expected waiter is observed.
  for (let attempt = 0; attempt < 150; attempt++) {
    const row = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND usename=$1 AND wait_event_type='Lock' AND ${predicate}`, [role])).rows[0];
    if (row.n >= minimum) return;
    await delay(15);
  }
  throw new Error("Expected real PostgreSQL lock waiter was not observed");
}

export function content(text) { return { version: 1, blocks: [{ type: "paragraph", text }] }; }

export function assertSummary(story) {
  assert.deepEqual(Object.keys(story).sort(), ["id", "slug", "kind", "state", "version", "draftTitle", "hasUnpublishedChanges", "updatedAt"].sort());
  assert.match(story.id, /^[0-9a-f-]{36}$/);
  assert.match(story.slug, /^story-[0-9a-f]{32}$/);
  assert.ok(Number.isInteger(story.version));
  assert.ok(Number.isFinite(Date.parse(story.updatedAt)));
}

export function privateHeaders(response) {
  assert.match(response.headers["cache-control"] ?? "", /private/);
  assert.match(response.headers["cache-control"] ?? "", /no-store/);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
}
