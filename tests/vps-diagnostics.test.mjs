import test from "node:test";
import assert from "node:assert/strict";
import { initializeLab } from "../scripts/production/vps-bootstrap.mjs";

test("bootstrap failure identifies its fixed phase without exposing child diagnostics", async t => {
  const output = [];
  t.mock.method(process.stderr, "write", chunk => { output.push(String(chunk)); return true; });
  const privateDiagnostic = "postgresql://internal:synthetic-password@private-db/hidden";
  const ctx = {
    compose: () => {},
    operation: name => { if (name === "migrate") throw new Error(privateDiagnostic); },
  };
  await assert.rejects(initializeLab(ctx, async () => true), { message: "VPS_LAB_FAILED_INGRESS_CLOSED" });
  assert.equal(output.at(-1), "VPS_LAB_PHASE=database-migrate\n");
  assert.ok(output.every(line => /^VPS_LAB_PHASE=[a-z-]+\n$/.test(line)));
  assert.ok(!output.join("").includes(privateDiagnostic));
});

test("HTTPS failure retains the HTTPS phase after closing the private entrance", async t => {
  const output = [], stopped = [];
  t.mock.method(process.stderr, "write", chunk => { output.push(String(chunk)); return true; });
  const ctx = { operation: () => {}, compose: args => { if (args[0] === "stop") stopped.push(args[1]); } };
  await assert.rejects(initializeLab(ctx, async () => { throw new Error("sensitive TLS fixture"); }), /VPS_LAB_FAILED_INGRESS_CLOSED/);
  assert.equal(output.at(-1), "VPS_LAB_PHASE=https-check\n");
  assert.deepEqual(stopped, ["proxy", "app"]);
  assert.ok(!output.join("").includes("sensitive"));
});
