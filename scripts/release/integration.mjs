import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectOciArchive } from "./bundle.mjs";

const stages = ["docker-info", "source-container", "extract-runtime", "builder", "oci-export", "oci-verify",
  "oci-load", "loaded-descriptor", "digest-execution", "cleanup"];
const failureCodes = ["RELEASE_PLATFORM_REJECTED", "RELEASE_CONTAINERD_REQUIRED", "RELEASE_CONTAINER_COMMAND_FAILED",
  "RELEASE_LOADED_DIGEST_MISMATCH", "RELEASE_BLOB_DIGEST_REJECTED", "RELEASE_IMAGE_SOURCE_MISMATCH",
  "RELEASE_NONROOT_REQUIRED", "RELEASE_EMBEDDED_SECRET_REJECTED", "RELEASE_OCI_LAYOUT_REQUIRED"];

/** Only fixed classifications reach CI; never child stderr, arguments, Docker
 * info, filesystem paths, or an arbitrary exception/AssertionError payload. */
export function releaseProbeFailure(error) {
  const candidate = error?.message?.split(/[\s:]/, 1)[0];
  return { code: failureCodes.includes(candidate) ? candidate : "RELEASE_CONTAINER_PROBE_FAILED",
    stage: stages.includes(error?.releaseProbeStage) ? error.releaseProbeStage : "unknown" };
}

/** Small real Linux image, not another four-image application rebuild. BusyBox
 * comes from the already-built synthetic proxy; no credentials or DB involved. */
export async function runReleaseContainerProbe() {
  const id = randomUUID().replaceAll("-", ""), name = `mq-release-probe-${id}`;
  const directory = await mkdtemp(join(tmpdir(), "mq-release-probe-"));
  const image = `mq-release-probe:${id}`, sourceSha = "a".repeat(40);
  let stage = "docker-info";
  const docker = (args, expected = 0) => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 ** 2 });
    if (result.error || result.status !== expected) throw Object.assign(new Error("RELEASE_CONTAINER_COMMAND_FAILED"), { releaseProbeStage: stage });
    return result.stdout.trim();
  };
  let containerCreated = false, builderCreated = false, loaded = false;
  try {
    const info = JSON.parse(docker(["info", "--format", "{{json .}}"]));
    console.log(`RELEASE_CONTAINER_CAPABILITIES ${JSON.stringify({ linux: info.OSType === "linux",
      amd64: ["x86_64", "amd64"].includes(info.Architecture),
      containerd: Array.isArray(info.DriverStatus) && info.DriverStatus.some(row => Array.isArray(row) && row.includes("io.containerd.snapshotter.v1")) })}`);
    assert.ok(info.OSType === "linux" && ["x86_64", "amd64"].includes(info.Architecture), "RELEASE_PLATFORM_REJECTED");
    assert.ok(Array.isArray(info.DriverStatus) && info.DriverStatus.some(row => Array.isArray(row) && row.includes("io.containerd.snapshotter.v1")), "RELEASE_CONTAINERD_REQUIRED");
    stage = "source-container";
    docker(["create", "--name", name, "--network", "none", process.env.MQ_LAB_PROXY_IMAGE ?? "mq-p302-proxy:local"]);
    containerCreated = true;
    stage = "extract-runtime";
    for (const [from, to] of [["/bin/busybox", "busybox"], ["/lib/ld-musl-x86_64.so.1", "ld-musl-x86_64.so.1"]]) {
      docker(["cp", "--follow-link", `${name}:${from}`, join(directory, to)]);
    }
    await writeFile(join(directory, "Dockerfile"), `FROM scratch\nCOPY busybox /bin/busybox\nCOPY ld-musl-x86_64.so.1 /lib/ld-musl-x86_64.so.1\nUSER 10001:10001\nLABEL org.opencontainers.image.revision=${sourceSha}\nLABEL mq.synthetic.run=${id}\nENTRYPOINT ["/bin/busybox"]\nCMD ["printf","MQ_RELEASE_PROBE_OK\\n"]\n`);
    stage = "builder";
    docker(["buildx", "create", "--name", name, "--driver", "docker-container", "--driver-opt",
      "image=moby/buildkit@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe"]);
    builderCreated = true;
    const archive = join(directory, "probe.oci.tar");
    stage = "oci-export";
    docker(["buildx", "build", "--builder", name, "--platform", "linux/amd64", "--network", "none",
      "--tag", image, "--output", `type=oci,dest=${archive}`, directory]);
    stage = "oci-verify";
    const checked = await inspectOciArchive(archive, { sourceSha });
    stage = "oci-load";
    docker(["image", "load", "--input", archive]); loaded = true;
    stage = "loaded-descriptor";
    const descriptor = JSON.parse(docker(["image", "inspect", image, "--format", "{{json .Descriptor}}"]));
    assert.equal(descriptor.digest, checked.indexDigest, "RELEASE_LOADED_DIGEST_MISMATCH");
    stage = "digest-execution";
    const output = docker(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", checked.indexDigest]);
    assert.equal(output, "MQ_RELEASE_PROBE_OK");
    return { synthetic: true, productionDeployed: false, platform: checked.platform,
      indexDigest: checked.indexDigest, manifestDigest: checked.manifestDigest, configDigest: checked.configDigest,
      archiveSha256: checked.archiveSha256, archiveBytes: checked.archiveBytes, loadedAndExecutedByDigest: true };
  } catch (error) {
    throw Object.assign(new Error(releaseProbeFailure(error).code), { releaseProbeStage: stage });
  } finally {
    stage = "cleanup";
    if (containerCreated) docker(["rm", name]);
    if (builderCreated) docker(["buildx", "rm", name]);
    if (loaded) docker(["image", "rm", image]);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runReleaseContainerProbe())); }
  catch (error) { console.error(`RELEASE_CONTAINER_PROBE_FAILED ${JSON.stringify(releaseProbeFailure(error))}`); process.exitCode = 1; }
}
