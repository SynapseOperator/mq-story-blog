import { loadLab } from "./vps-bootstrap.mjs";
import { runVpsMaintenance } from "./vps-maintenance.mjs";

try {
  const [action, directory, ...extra] = process.argv.slice(2);
  if (extra.length || !["faults", "restore"].includes(action)) throw new Error("VPS_ACTION_REJECTED");
  const result = await runVpsMaintenance(await loadLab(directory), action);
  console.log(JSON.stringify(result));
} catch {
  console.error("VPS_MAINTENANCE_FAILED; inspect the isolated target; do not blindly retry restoration");
  process.exitCode = 1;
}
