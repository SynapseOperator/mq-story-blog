import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { URL } from "node:url";

// Execute the actual entrypoints in separate processes. Replace only their
// dependencies: no database, HTTP listener, real secret or filesystem fixture.
// The PostgreSQL suite separately exercises a real terminated idle connection.
for (const entry of ["start", "healthcheck"]) {
  for (const point of ["none", "audit", "end"]) {
    test(`production ${entry}: ${point === "none" ? "healthy pool permits the next operation" : `idle error during ${point} fails closed without a Client dump`}`, () => {
      const emitError = "this.emit('error', Object.assign(new Error('SYNTHETIC_IDLE_ERROR'), { client: { password: 'synthetic-private-probe' } }));";
      const modules = {
        "mq-probe:pg": `
          import { EventEmitter } from 'node:events';
          export default { Pool: class extends EventEmitter {
            async end() {
              globalThis.probeEnded = true;
              ${point === "end" ? emitError : ""}
            }
          } };
        `,
        "mq-probe:runtime": `
          export async function loadRuntimeEnvironment() {
            return { env: { NODE_ENV: 'production' }, config: { origin: 'https://synthetic.invalid' } };
          }
        `,
        "mq-probe:audit": `
          export async function auditRuntimeDatabase(pool) {
            ${point === "audit" ? emitError.replace("this.emit", "pool.emit") : ""}
          }
        `,
        "mq-probe:server": "globalThis.probeListenerOpened = true;",
      };
      const script = `
        import { registerHooks } from 'node:module';
        const modules = ${JSON.stringify(modules)};
        registerHooks({
          resolve(specifier, context, next) {
            const mapped = specifier === 'pg' ? 'mq-probe:pg'
              : specifier === './runtime-config.mjs' ? 'mq-probe:runtime'
              : specifier === './database.mjs' ? 'mq-probe:audit'
              : specifier === '../../server.js' ? 'mq-probe:server' : null;
            return mapped ? { url: mapped, shortCircuit: true } : next(specifier, context);
          },
          load(url, context, next) {
            return modules[url] ? { format: 'module', source: modules[url], shortCircuit: true } : next(url, context);
          },
        });
        globalThis.fetch = async () => {
          globalThis.probeHealthRequested = true;
          return { ok: true, body: { cancel: async () => {} } };
        };
        await import(${JSON.stringify(new URL(`../scripts/production/${entry}.mjs`, import.meta.url).href)});
        console.log(JSON.stringify({
          ended: globalThis.probeEnded === true,
          listenerOpened: globalThis.probeListenerOpened === true,
          healthRequested: globalThis.probeHealthRequested === true,
        }));
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        encoding: "utf8", timeout: 15000, windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, point === "none" ? 0 : 1);
      assert.deepEqual(JSON.parse(result.stdout.trim()), {
        ended: true,
        listenerOpened: entry === "start" && point === "none",
        healthRequested: entry === "healthcheck" && point === "none",
      });
      assert.equal(result.stderr.trim(), entry === "start" && point !== "none" ? "MQ_STARTUP_REJECTED" : "");
    });
  }
}
