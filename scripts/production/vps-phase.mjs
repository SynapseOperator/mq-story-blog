import { loadLab } from "./vps-bootstrap.mjs";
import { runVpsMaintenance } from "./vps-maintenance.mjs";

let stage = "arguments";
try {
  const [action, directory, ...extra] = process.argv.slice(2);
  if (extra.length || !["faults", "restore"].includes(action)) throw new Error("VPS_ACTION_REJECTED");
  stage = "load-lab";
  const context = await loadLab(directory);
  stage = "maintenance";
  const result = await runVpsMaintenance(context, action);
  console.log(JSON.stringify(result));
} catch {
  console.error(`VPS_MAINTENANCE_ENTRY_STAGE=${stage}`);
  console.error("VPS_MAINTENANCE_FAILED; inspect the isolated target; do not blindly retry restoration");
  process.exitCode = 1;
}
