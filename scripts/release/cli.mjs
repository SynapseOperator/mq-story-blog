import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { githubRequest, verifyReleaseGate } from "./gate.mjs";
import { createReleaseManifest, verifyReleaseBundle } from "./bundle.mjs";
import { planRelease } from "./deploy.mjs";
import { readDeploymentManifest, readDeploymentFile } from "../production/runtime-config.mjs";

export async function runReleaseCommand(args, env = process.env) {
  try {
    const [operation, ...values] = args;
    if (operation === "gate" && values.length === 2) {
      const evidence = await verifyReleaseGate({ sourceSha: values[0], request: githubRequest(env.GH_TOKEN) });
      await writeFile(resolve(values[1]), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o444 });
      console.log(JSON.stringify(evidence));
    } else if (operation === "manifest" && values.length === 4) {
      const gate = JSON.parse(await readFile(resolve(values[2]), "utf8"));
      const result = await createReleaseManifest({ directory: resolve(values[0]), sourceSha: values[1],
        gate, projectRoot: resolve(values[3]) });
      console.log(JSON.stringify({ sourceSha: result.release.sourceSha, manifestSha256: result.manifestSha256,
        images: result.release.images }));
    } else if (operation === "verify" && values.length === 2) {
      const release = await verifyReleaseBundle(resolve(values[0]), values[1]);
      console.log(JSON.stringify({ verified: true, sourceSha: release.sourceSha, platform: release.platform }));
    } else if (operation === "plan" && [6, 7].includes(values.length)) {
      const [directory, expected, previous, previousExpected, manifestPath, receiptPath, mode] = values;
      const release = await verifyReleaseBundle(resolve(directory), expected);
      const currentRelease = await verifyReleaseBundle(resolve(previous), previousExpected);
      const config = await readDeploymentManifest(resolve(manifestPath));
      // validateDeploymentConfig rejects a second derived role map; use the
      // original external manifest as the release target contract.
      const manifest = { ...config }; delete manifest.roles;
      const backupReceipt = JSON.parse(await readDeploymentFile(resolve(receiptPath), { secret: true }));
      console.log(JSON.stringify(planRelease({ release, currentRelease, config: manifest, backupReceipt, mode }), null, 2));
    } else throw new Error("RELEASE_COMMAND_REJECTED");
    return 0;
  } catch {
    console.error("RELEASE_COMMAND_REJECTED (check reviewed source, CI, archive integrity and explicit target; details withheld)");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runReleaseCommand(process.argv.slice(2));
