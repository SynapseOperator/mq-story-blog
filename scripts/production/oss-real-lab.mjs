import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { verifyPrivateDirectory, verifyPrivateFile } from "../media/backup-files.mjs";
import { MOTO_IMAGE } from "./s3-lab.mjs";

export const OSS_LAB_CONFIRM = "synthetic-cloud-under-1gib";
export function ossLabRepository(id, confirmation) {
  assert.equal(confirmation, OSS_LAB_CONFIRM, "OSS_REAL_LAB_CONFIRM_REQUIRED");
  assert.match(id ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  return `s3:https://oss-cn-hongkong.aliyuncs.com/mq-story-backups/p502-synthetic/${id}`;
}

export function ossLabBudget(databaseBytes, mediaBytes) {
  for (const value of [databaseBytes, mediaBytes]) assert.ok(Number.isSafeInteger(value) && value >= 0);
  // This fixture is tiny. Leave ample headroom for dump/container metadata and
  // Restic encryption before the owner's 1 GiB upload ceiling is approached.
  const conservativeBytes = databaseBytes + mediaBytes + 16 * 1024 ** 2;
  assert.ok(conservativeBytes < 128 * 1024 ** 2, "OSS_SYNTHETIC_UPLOAD_BUDGET_EXCEEDED");
  return { databaseBytes, mediaBytes, conservativeBytes, uploadCeilingBytes: 1024 ** 3 };
}

export async function readRealOssLab(id, secretValues, env = process.env) {
  const repository = ossLabRepository(id, env.MQ_LAB_OSS_CONFIRM);
  assert.ok(env.MQ_LAB_OSS_CREDENTIALS_FILE && env.MQ_LAB_OSS_PASSWORD_FILE);
  const credentialsFile = resolve(env.MQ_LAB_OSS_CREDENTIALS_FILE), passwordFile = resolve(env.MQ_LAB_OSS_PASSWORD_FILE);
  await verifyPrivateDirectory(dirname(credentialsFile)); await verifyPrivateDirectory(dirname(passwordFile));
  const credentials = (await verifyPrivateFile(credentialsFile, 4096)).toString("utf8");
  const parsed = JSON.parse(credentials);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  assert.ok(["accessKeyId,secretAccessKey", "accessKeyId,secretAccessKey,sessionToken"].includes(Object.keys(parsed).sort().join(",")));
  for (const value of Object.values(parsed)) {
    assert.ok(typeof value === "string" && /^[\x21-\x7e]+$/.test(value)); secretValues.add(value);
  }
  const password = (await verifyPrivateFile(passwordFile, 4096)).toString("utf8").replace(/\r?\n$/, "");
  assert.ok(password.length >= 32 && password.length <= 1024 && !/[\r\n\0]/.test(password));
  secretValues.add(credentials); secretValues.add(password);
  const recordDirectory = dirname(passwordFile);
  await writeFile(join(recordDirectory, `oss-attempt-${id}.json`), JSON.stringify({ repository, id,
    startedAt: new Date().toISOString(), synthetic: true, preserveCloudRepository: true }), { flag: "wx", mode: 0o600 });
  return { id, repository, recordDirectory, credentials, password };
}

export async function startRealOssLab(ctx, options) {
  const { docker, project, images, volumeNames, temporaryContainers } = ctx;
  const network = `${project}_oss-egress`, volume = `${project}_oss-secrets`;
  assert.notEqual(docker(["network", "inspect", network], { fail: false }).status, 0);
  docker(["network", "create", "--label", `mq.lab=${options.id}`, network]); options.network = network;
  assert.notEqual(docker(["volume", "inspect", volume], { fail: false }).status, 0);
  docker(["volume", "create", "--label", `mq.lab=${options.id}`, volume]); volumeNames["oss-secrets"] = volume;
  const name = `${project}-oss-secret-loader`; temporaryContainers.add(name);
  // stdin only: no cloud credential in argv/env, Docker metadata, image layers,
  // host lab staging directories or diagnostics. Source private files survive.
  docker(["run", "--rm", "-i", "--name", name, "--network", "none", "--user", "0:0", "--read-only",
    "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--mount", `type=volume,source=${volume},target=/target`,
    "--mount", "type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=1048576", images.tools,
    "--input-type=module", "--eval", `import {writeFile,chown,chmod} from 'node:fs/promises';
      let body='';for await(const part of process.stdin)body+=part;
      const values=JSON.parse(body);
      for(const name of ['s3_credentials','restic_password']){
        await writeFile('/target/'+name,values[name],{flag:'wx',mode:0o400});await chown('/target/'+name,10001,10001);
      }await chown('/target',10001,10001);await chmod('/target',0o700);`],
  { input: JSON.stringify({ s3_credentials: options.credentials, restic_password: options.password }) });
  temporaryContainers.delete(name);
  delete options.credentials; delete options.password;
  return { ...options, backend: "s3", volume };
}

/** Remove only the transient cloud-secret copy created by this run, on both
 * success and failure. Source files, failed DB/media volumes and OSS remain. */
export function removeRealOssSecret({ docker, project, volumeNames }, options) {
  const name = volumeNames["oss-secrets"];
  if (!name) return;
  assert.equal(name, `${project}_oss-secrets`, "OSS_SECRET_CLEANUP_TARGET_REJECTED");
  const found = docker(["volume", "inspect", name, "--format", '{{index .Labels "mq.lab"}}'], { fail: false });
  assert.equal(found.status, 0, "OSS_SECRET_CLEANUP_INSPECTION_FAILED");
  assert.equal(found.stdout.trim(), options.id, "OSS_SECRET_CLEANUP_OWNER_REJECTED");
  const removed = docker(["volume", "rm", name], { fail: false });
  assert.equal(removed.status, 0, "OSS_SECRET_CLEANUP_FAILED");
  delete volumeNames["oss-secrets"];
}

export async function inspectRealOss(ctx, remote, action) {
  assert.ok(["empty", "measure"].includes(action));
  const script = await readFile(new URL("./oss-inspect.py", import.meta.url), "utf8");
  const result = ctx.docker(["run", "--rm", "--network", remote.network, "--user", "10001:10001", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "128m", "--pids-limit", "64",
    "--mount", `type=volume,source=${remote.volume},target=/run/oss,readonly`, "-e", "PYTHONDONTWRITEBYTECODE=1",
    "-e", `MQ_OSS_TEST_ID=${remote.id}`, "--entrypoint", "python", MOTO_IMAGE, "-c", script, action], { fail: false });
  if (result.status !== 0) {
    for (const line of result.stderr.split(/\r?\n/))
      if (/^OSS_INSPECTION_FAILED (?:operation=(?:ListObjectsV2|HeadObject|Unknown);)?code=[A-Za-z0-9-]{1,64}(?:;requestId=[A-Za-z0-9-]{1,128})?$/.test(line)) console.error(line);
    throw new Error("OSS_INSPECTION_REJECTED");
  }
  return JSON.parse(result.stdout);
}
