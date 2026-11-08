import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { startS3Lab, MOTO_IMAGE } from "./s3-lab.mjs";

// Real Restic + local TLS + Moto, with Docker-only OSS DNS aliases. This does
// not validate Alibaba's service, bucket settings or RAM policy enforcement.
const root = fileURLToPath(new URL("../../", import.meta.url));
const id = randomUUID(), project = `mq-oss-${id.replaceAll("-", "")}`;
const network = `${project}_database`, volumeNames = {}, temporaryContainers = new Set();
const images = { tools: process.env.MQ_LAB_TOOLS_IMAGE || "mq-p302-tools:local",
  operations: process.env.MQ_LAB_OPERATIONS_IMAGE || "mq-p303-operations:local",
  proxy: process.env.MQ_LAB_PROXY_IMAGE || "mq-p302-proxy:local" };
let stage = "preflight", networkCreated = false;
function docker(args, { fail = true, timeout = 180000, input } = {}) {
  const result = spawnSync("docker", args, { cwd: root, windowsHide: true, encoding: "utf8",
    input, timeout, maxBuffer: 4 * 1024 * 1024 });
  if (fail && (result.error || result.status !== 0)) throw new Error("OSS_LAB_DOCKER_FAILED");
  return result;
}
async function volume(name, entries) {
  assert.match(name, /^[a-z][a-z-]*$/);
  const full = `${project}_${name}`;
  assert.notEqual(docker(["volume", "inspect", full], { fail: false }).status, 0);
  docker(["volume", "create", "--label", `mq.oss-lab=${id}`, full]); volumeNames[name] = full;
  docker(["run", "--rm", "-i", "--network", "none", "--user", "0:0", "--read-only", "--cap-drop", "ALL",
    "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--mount", `type=volume,source=${full},target=/target`,
    "--mount", "type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=1048576", images.tools,
    "--input-type=module", "--eval", `import {writeFile,chown,chmod} from 'node:fs/promises';
      let input='';for await(const chunk of process.stdin)input+=chunk;
      for(const [name,value]of Object.entries(JSON.parse(input))){
        if(!/^[a-zA-Z0-9._-]+$/.test(name))throw Error('LAB_FILENAME_REJECTED');
        await writeFile('/target/'+name,value,{flag:'wx',mode:0o400});await chown('/target/'+name,10001,10001);
      }await chown('/target',10001,10001);await chmod('/target',0o700);`], { input: JSON.stringify(entries) });
  return full;
}
try {
  assert.equal(process.argv.length, 2);
  for (const image of [...Object.values(images), MOTO_IMAGE]) docker(["image", "inspect", image, "--format", "{{.Id}}"]);
  assert.notEqual(docker(["network", "inspect", network], { fail: false }).status, 0);
  docker(["network", "create", "--internal", "--label", `mq.oss-lab=${id}`, network]); networkCreated = true;
  assert.equal(docker(["network", "inspect", network, "--format", "{{.Internal}}"] ).stdout.trim(), "true");
  stage = "fixture";
  await startS3Lab({ docker, project, volume, volumeNames, images, temporaryContainers }, { oss: true });
  await volume("work", {});
  await volume("secrets", { "restic-password": randomBytes(32).toString("hex"),
    "wrong-password": randomBytes(32).toString("hex") });
  // The test CA becomes this disposable container's system trust store. The
  // actual OSS wrapper still rejects explicit CA overrides and insecure TLS.
  const caPath = "/data/caddy/pki/authorities/local/root.crt";
  const ca = docker(["exec", `${project}-s3-tls`, "cat", caPath]).stdout;
  await volume("system-trust", { "ca-certificates.crt": ca });
  const client = `${project}-client`; temporaryContainers.add(client);
  stage = "restic-backup-and-restore";
  const result = docker(["run", "--name", client, "--network", network, "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--memory", "384m", "--cpus", "1", "--pids-limit", "128",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m,uid=10001,gid=10001,mode=0700",
    "--mount", "type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=1048576",
    "--mount", `type=volume,source=${volumeNames.work},target=/work`,
    "--mount", `type=volume,source=${volumeNames.secrets},target=/run/secrets,readonly`,
    "--mount", `type=volume,source=${volumeNames["remote-credentials"]},target=/run/s3,readonly`,
    "--mount", `type=volume,source=${volumeNames["system-trust"]},target=/etc/ssl/certs,readonly`,
    "--mount", `type=bind,source=${fileURLToPath(new URL("./backup-tools.mjs", import.meta.url))},target=/app/scripts/production/backup-tools.mjs,readonly`,
    "--mount", `type=bind,source=${fileURLToPath(new URL("../../tests/fixtures/oss-transport-actions.mjs", import.meta.url))},target=/app/tests/fixtures/oss-transport-actions.mjs,readonly`,
    "-e", "MQ_SYNTHETIC_LAB=true", "-e", `MQ_LAB_OSS_PROJECT=${project}`,
    images.operations, "tests/fixtures/oss-transport-actions.mjs"], { fail: false, timeout: 180000 });
  for (const line of result.stderr.split(/\r?\n/))
    if (/^OSS_TRANSPORT_ACTION_FAILED phase=[a-z-]+; child diagnostics withheld$/.test(line)) console.error(line);
  assert.equal(result.status, 0, "OSS_RESTIC_TRANSPORT_FAILED");
  assert.match(result.stdout, /PASS OSS transport:/);
  const evidence = JSON.parse(docker(["exec", `${project}-s3`, "cat", "/credentials/transport.json"]).stdout);
  assert.ok(evidence.requests > 10); assert.equal(evidence.virtualHost, true); assert.equal(evidence.regionScope, true);
  assert.ok(evidence.headBucketDenied > 0); assert.equal(evidence.unscopedListsDenied, 0); assert.equal(evidence.nonLockDeletesDenied, 0);
  for (const method of ["GET", "PUT", "DELETE"]) assert.ok(evidence.methods.includes(method));
  console.log(`PASS OSS transport: Restic 0.19.1, virtual-hosted HTTPS, oss-cn-hongkong signing scope, encrypted backup/check/restore; ${evidence.requests} local requests`);
  console.log("No Alibaba endpoint, real bucket, RAM identity or production credentials were used.");
} catch {
  console.error(`OSS_TRANSPORT_TEST_FAILED stage=${stage}; child diagnostics withheld`);
  process.exitCode = 1;
} finally {
  // Only exact random resources created above. No host files or shared volumes.
  for (const name of temporaryContainers) docker(["rm", "-f", name], { fail: false });
  for (const name of Object.values(volumeNames)) {
    const owned = docker(["volume", "inspect", name, "--format", '{{index .Labels "mq.oss-lab"}}'], { fail: false });
    if (owned.status === 0 && owned.stdout.trim() === id) docker(["volume", "rm", name], { fail: false });
  }
  if (networkCreated) docker(["network", "rm", network], { fail: false });
}
