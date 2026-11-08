import assert from "node:assert/strict";
import test from "node:test";
import { ossLabBudget, ossLabRepository, OSS_LAB_CONFIRM, startRealOssLab, removeRealOssSecret } from "../scripts/production/oss-real-lab.mjs";

test("real OSS rehearsal requires explicit consent and an isolated random test prefix", () => {
  const id = "eb750f17-0583-4d8a-9100-bae239e11a66";
  assert.equal(ossLabRepository(id, OSS_LAB_CONFIRM), `s3:https://oss-cn-hongkong.aliyuncs.com/mq-story-backups/p502-synthetic/${id}`);
  assert.throws(() => ossLabRepository(id, "true"));
  for (const value of ["production", "../production", "", `${id}/production`]) assert.throws(() => ossLabRepository(value, OSS_LAB_CONFIRM));
});

test("synthetic upload budget rejects excessive or untrustworthy size before remote writes", () => {
  const budget = ossLabBudget(12 * 1024 ** 2, 2000);
  assert.ok(budget.conservativeBytes < 128 * 1024 ** 2);
  assert.equal(budget.uploadCeilingBytes, 1024 ** 3);
  for (const args of [[128 * 1024 ** 2, 0], [0, 128 * 1024 ** 2], [-1, 0], [1.5, 0], [NaN, 0], [1, Infinity]])
    assert.throws(() => ossLabBudget(...args));
});

test("real-cloud secrets enter the isolated loader on stdin, never Docker arguments or host staging", async () => {
  const calls = [], id = "eb750f17-0583-4d8a-9100-bae239e11a66", project = "mq-p302-" + id.replaceAll("-", "");
  const credentials = JSON.stringify({ accessKeyId: "syntheticAccess", secretAccessKey: "syntheticSecret" });
  const password = "synthetic-restic-password-for-unit-test";
  const options = { id, credentials, password, repository: ossLabRepository(id, OSS_LAB_CONFIRM) };
  const context = { project, images: { tools: "synthetic:local" }, volumeNames: {}, temporaryContainers: new Set(),
    docker(args, settings) { calls.push({ args, settings }); return { status: args[1] === "inspect" ? 1 : 0 }; } };
  const result = await startRealOssLab(context, options);
  const commandLine = JSON.stringify(calls.map(call => call.args));
  for (const value of [credentials, password, "syntheticAccess", "syntheticSecret"]) assert.ok(!commandLine.includes(value));
  const loader = calls.find(call => call.args[0] === "run");
  assert.deepEqual(JSON.parse(loader.settings.input), { s3_credentials: credentials, restic_password: password });
  assert.ok(loader.args.includes("--network") && loader.args.includes("none"));
  assert.ok(loader.args.includes("--read-only"));
  assert.equal(result.volume, `${project}_oss-secrets`);
  assert.equal(options.credentials, undefined); assert.equal(options.password, undefined);
  assert.equal(context.temporaryContainers.size, 0);
});

for (const failed of [false, true]) test(`transient secret cleanup runs after ${failed ? "failed" : "successful"} rehearsal without touching data volumes`, async () => {
  const id = "eb750f17-0583-4d8a-9100-bae239e11a66", project = "mq-p302-" + id.replaceAll("-", ""), calls = [];
  const context = { project, volumeNames: { "oss-secrets": `${project}_oss-secrets`, media: `${project}_media`, operations: `${project}_operations` },
    docker(args) { calls.push(args); return { status: 0, stdout: args[1] === "inspect" ? id : "" }; } };
  const rehearsal = async () => {
    try { if (failed) throw new Error("synthetic interruption"); }
    finally { removeRealOssSecret(context, { id }); }
  };
  if (failed) await assert.rejects(rehearsal(), /synthetic interruption/); else await rehearsal();
  assert.deepEqual(calls.filter(args => args[1] === "rm"), [["volume", "rm", `${project}_oss-secrets`]]);
  assert.deepEqual(context.volumeNames, { media: `${project}_media`, operations: `${project}_operations` });
});

test("secret cleanup refuses an unowned volume or a failed removal", () => {
  const id = "eb750f17-0583-4d8a-9100-bae239e11a66", project = "mq-p302-" + id.replaceAll("-", "");
  for (const wrongLabel of [true, false]) {
    const calls = [], volumeNames = { "oss-secrets": `${project}_oss-secrets` };
    assert.throws(() => removeRealOssSecret({ project, volumeNames, docker(args) {
      calls.push(args); return { status: args[1] === "rm" ? 1 : 0, stdout: wrongLabel ? "another-run" : id };
    } }, { id }), wrongLabel ? /OSS_SECRET_CLEANUP_OWNER_REJECTED/ : /OSS_SECRET_CLEANUP_FAILED/);
    assert.equal(calls.some(args => args[1] === "rm"), !wrongLabel);
    assert.equal(volumeNames["oss-secrets"], `${project}_oss-secrets`);
  }
});
