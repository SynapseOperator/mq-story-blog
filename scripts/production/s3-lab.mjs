import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";

// Fixed official test image, isolated network only. It is never part of a release.
export const MOTO_IMAGE = "ghcr.io/getmoto/motoserver:5.2.5@sha256:59a1965d845249b04def37a0e2565f9cc6c44543cb89b68e90f28f344b3b0d1a";

export async function startS3Lab({ docker, project, volume, volumeNames, images, temporaryContainers }) {
  await volume("remote-credentials", {});
  await volume("remote-config", { Caddyfile: "{\n admin off\n}\nhttps://mq-backup.localhost {\n tls internal\n reverse_proxy mq-s3:5000\n}\n" });
  const name = `${project}-s3`, tlsName = `${project}-s3-tls`;
  temporaryContainers.add(name); temporaryContainers.add(tlsName);
  const script = await readFile(new URL("./s3-fixture.py", import.meta.url), "utf8");
  docker(["run", "-d", "--name", name, "--network", `${project}_database`, "--network-alias", "mq-s3",
    "--user", "10001:10001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--memory", "384m", "--cpus", "1", "--pids-limit", "128", "--tmpfs", "/tmp:rw,nosuid,size=32m,uid=10001,gid=10001,mode=0700",
    "--mount", `type=volume,source=${volumeNames["remote-credentials"]},target=/credentials`,
    "-e", "PYTHONDONTWRITEBYTECODE=1", "--entrypoint", "python", MOTO_IMAGE, "-c", script]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const logs = docker(["logs", name]).stdout;
    if (logs.includes("S3_FIXTURE_READY")) { ready = true; break; }
    await delay(500);
  }
  assert.ok(ready, "S3_FIXTURE_NOT_READY");
  console.log("PASS release: isolated S3 fixture rejects incorrect access key and signing secret");
  docker(["run", "-d", "--name", tlsName, "--network", `${project}_database`, "--network-alias", "mq-backup.localhost",
    "--read-only", "--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE", "--security-opt", "no-new-privileges:true", "--memory", "96m", "--pids-limit", "128",
    "--tmpfs", "/data:rw,nosuid,size=8m,uid=10001,gid=10001,mode=0700",
    "--tmpfs", "/config:rw,nosuid,size=8m,uid=10001,gid=10001,mode=0700",
    "--mount", `type=volume,source=${volumeNames["remote-config"]},target=/etc/mq-s3,readonly`,
    "--entrypoint", "/usr/bin/caddy", images.proxy, "run", "--config", "/etc/mq-s3/Caddyfile", "--adapter", "caddyfile"]);
  let ca;
  for (let attempt = 0; attempt < 60; attempt++) {
    const read = docker(["exec", tlsName, "cat", "/data/caddy/pki/authorities/local/root.crt"], { fail: false });
    if (read.status === 0 && read.stdout.includes("BEGIN CERTIFICATE")) { ca = read.stdout; break; }
    await delay(500);
  }
  assert.ok(ca, "S3_TLS_NOT_READY");
  console.log("PASS release: private S3 endpoint has a locally trusted Caddy certificate");
  await volume("remote-ca", { "ca.crt": ca });
  for (const container of [name, tlsName]) {
    const ports = JSON.parse(docker(["inspect", container, "--format", "{{json .HostConfig.PortBindings}}"] ).stdout);
    assert.ok(!ports || Object.keys(ports).length === 0);
  }
  return { backend: "s3", repository: `s3:https://mq-backup.localhost/mq-lab/${project}` };
}
