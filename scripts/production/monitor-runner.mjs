import assert from "node:assert/strict";
import { collectExternalAvailability, collectOperations } from "./operations-check.mjs";
import { createOperationsAlert, sendOperationsAlert } from "./alert-webhook.mjs";

// Scheduled probes are read-only and notifications are previews unless --send
// was explicitly enabled after a real receiver/owner delivery acceptance.
try {
  const args = process.argv.slice(2);
  assert.ok(args.length <= 2 && new Set(args).size === args.length && args.every(arg => ["--external", "--send"].includes(arg)));
  const deploymentId = process.env.MQ_OPS_DEPLOYMENT_ID;
  assert.match(deploymentId ?? "", /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  let result;
  try {
    result = args.includes("--external")
      ? await collectExternalAvailability({ origin: process.env.MQ_OPS_ORIGIN })
      : await collectOperations({ project: process.env.MQ_OPS_PROJECT, deploymentId, diskPath: process.env.MQ_OPS_DISK_PATH,
        origin: process.env.MQ_OPS_ORIGIN, receiptPath: process.env.MQ_OPS_BACKUP_RECEIPT });
  } catch { result = { ok: false, failures: ["OPERATIONS_CHECK_FAILED"] }; }
  const report = { deploymentId, checkedAt: new Date().toISOString(), failures: result.failures };
  console.log(JSON.stringify({ check: args.includes("--external") ? "mq-external" : "mq-operations", ...report, ok: result.ok }));
  const delivery = args.includes("--send")
    ? await sendOperationsAlert({ report, webhookUrlFile: process.env.MQ_ALERT_WEBHOOK_URL_FILE,
      channel: process.env.MQ_ALERT_CHANNEL ?? "generic", signingSecretFile: process.env.MQ_ALERT_SIGNING_SECRET_FILE })
    : { dryRun: true, alert: createOperationsAlert(report) };
  console.log(JSON.stringify(delivery));
  if (!result.ok || delivery.delivered === false && !delivery.skipped) process.exitCode = 1;
} catch { console.error("MQ_MONITOR_FAILED"); process.exitCode = 1; }
