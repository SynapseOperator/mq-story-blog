import { pathToFileURL } from "node:url";
import { prepareProductionHost, applyProductionHost } from "./production-host.mjs";

export async function productionCommand(args) {
  try {
    const [command, action, settings, confirmation, ...extra] = args;
    if (extra.length || !["plan", "apply"].includes(command) || !settings
      || (command === "plan" && confirmation !== undefined)) throw new Error();
    const context = await prepareProductionHost(settings, action);
    if (command === "plan") {
      console.log(JSON.stringify(context.plan));
      return 0;
    }
    const result = await applyProductionHost(context, confirmation);
    console.log(JSON.stringify({ completed: true, action, deploymentId: result.receipt.deploymentId,
      sourceSha: result.receipt.sourceSha, publicIngress: result.receipt.publicIngress }));
    return 0;
  } catch (error) {
    const code = ["PRODUCTION_FAILED_INGRESS_CLOSED", "PRODUCTION_FAILED_CONTAINMENT_UNCONFIRMED",
      "PRODUCTION_PREFLIGHT_FAILED_NO_CHANGES", "PRODUCTION_VALIDATION_FAILED_NO_CHANGES"].includes(error.message)
      ? error.message : "PRODUCTION_OPERATION_REJECTED";
    console.error(`${code}; preserve data and inspect the approved target; do not blindly retry`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await productionCommand(process.argv.slice(2));
