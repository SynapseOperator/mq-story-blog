import { createHmac, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import https from "node:https";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL, URL } from "node:url";

const codes = new Set([
  "ALERT_DELIVERY_TEST",
  "DISK_RESERVE_LOW", "INODES_LOW", "HOST_MEMORY_LOW", "HOST_LOAD_HIGH", "TLS_EXPIRY_OR_VERIFICATION_FAILED",
  "BACKUP_MISSING_OR_STALE", "MQ_OPERATIONS_CHECK_FAILED", "OPERATIONS_CHECK_FAILED", "HTTPS_UNAVAILABLE", "BACKUP_FAILED", "RESTORE_FAILED", "RELEASE_FAILED",
  ...["APP", "POSTGRES", "PROXY"].flatMap(name => [`${name}_UNHEALTHY`, `${name}_PORT_EXPOSED`, `${name}_MEMORY_HIGH`]),
]);

// Only this fixed DTO crosses the notification boundary. No sample, arbitrary
// message, HTTP response, URL, log excerpt or host identity is forwarded.
export function createOperationsAlert(report) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(report?.deploymentId ?? "")
    || typeof report.checkedAt !== "string" || !Number.isFinite(Date.parse(report.checkedAt))
    || new Date(report.checkedAt).toISOString() !== report.checkedAt
    || !Array.isArray(report.failures) || report.failures.length > 32 || report.failures.some(code => !codes.has(code))) {
    throw new Error("ALERT_REPORT_REJECTED");
  }
  return { version: 1, eventId: randomUUID(), deploymentId: report.deploymentId, checkedAt: report.checkedAt,
    failures: [...new Set(report.failures)] };
}

function postAlert(target, payload, { ca, timeoutMs, channel, connectHost }) {
  return new Promise(resolve => {
    let request;
    const timer = setTimeout(() => request?.destroy(new Error("ALERT_TIMEOUT")), timeoutMs);
    const done = result => { clearTimeout(timer); resolve(result); };
    request = https.request(target, { method: "POST", ca, rejectUnauthorized: true, agent: false,
      ...(connectHost ? { hostname: connectHost, servername: target.hostname } : {}),
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "user-agent": "mq-operations/1" } }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 200 && status < 300 && channel === "feishu") {
        // Feishu can reject a message with HTTP 200. Read only a bounded JSON
        // acknowledgement, never forward its message or any other response data.
        let bytes = 0; const chunks = [];
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 4096) { done({ delivered: false, errorCode: "ALERT_ACK_REJECTED", retryable: false }); response.destroy(); }
          else chunks.push(chunk);
        });
        response.once("end", () => {
          let accepted = false;
          try { accepted = JSON.parse(Buffer.concat(chunks).toString("utf8")).code === 0; } catch { /* Fixed failure only. */ }
          done(accepted ? { delivered: true } : { delivered: false, errorCode: "ALERT_ACK_REJECTED", retryable: false });
        });
        response.once("error", () => done({ delivered: false, errorCode: "ALERT_TRANSPORT_FAILED", retryable: true }));
        response.once("aborted", () => done({ delivered: false, errorCode: "ALERT_TRANSPORT_FAILED", retryable: true }));
      } else {
        response.destroy(); // Generic webhook acknowledgements need no body.
        if (status >= 200 && status < 300) done({ delivered: true });
        else if (status >= 300 && status < 400) done({ delivered: false, errorCode: "ALERT_REDIRECT_REJECTED", retryable: false });
        else done({ delivered: false, errorCode: "ALERT_HTTP_REJECTED", retryable: status === 429 || status >= 500 });
      }
    });
    request.once("error", () => done({ delivered: false, errorCode: "ALERT_TRANSPORT_FAILED", retryable: true }));
    request.end(payload);
  });
}

/** Explicit opt-in network action. Production uses the system trust store; the
 * optional CA permits a real local HTTPS receiver test without weakening TLS. */
export async function sendOperationsAlert({ report, webhookUrlFile, channel = "generic", signingSecretFile,
  projectRoot = process.cwd(), ca, timeoutMs = 5000, connectHost }) {
  const alert = createOperationsAlert(report);
  if (!alert.failures.length) return { delivered: false, skipped: "NO_ALERTS", attempts: 0, eventId: alert.eventId };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000) throw new Error("ALERT_CONFIG_REJECTED");
  let target, signingSecret;
  try {
    if (!["generic", "feishu"].includes(channel) || (channel === "generic" && signingSecretFile !== undefined)) throw new Error();
    const { readDeploymentFile } = await import("./runtime-config.mjs");
    const value = (await readDeploymentFile(webhookUrlFile, { projectRoot, secret: true })).replace(/\r?\n$/, "");
    if (value.length > 2048 || value.trim() !== value || /[\r\n\0]/.test(value)) throw new Error();
    target = new URL(value);
    if (target.protocol !== "https:" || target.username || target.password || target.hash) throw new Error();
    if (channel === "feishu") {
      if (target.hostname !== "open.feishu.cn" || target.search || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9_-]{16,128}$/.test(target.pathname)) throw new Error();
      signingSecret = (await readDeploymentFile(signingSecretFile, { projectRoot, secret: true })).replace(/\r?\n$/, "");
      if (!/^[\x21-\x7e]{16,256}$/.test(signingSecret)) throw new Error();
    }
  } catch { throw new Error("ALERT_CONFIG_REJECTED"); }
  let payload = alert;
  if (channel === "feishu") {
    // Official bot contract: HMAC-SHA256 of an empty message, using
    // `${timestamp}\n${secret}` as the key. No @ mentions or arbitrary text.
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload = { timestamp, sign: createHmac("sha256", `${timestamp}\n${signingSecret}`).update("").digest("base64"),
      msg_type: "text", content: { text: `MQ 运维告警${alert.failures.length === 1 && alert.failures[0] === "ALERT_DELIVERY_TEST" ? " · 送达测试（非故障）" : ""}\n${alert.checkedAt}\n部署 ${alert.deploymentId}\n事件 ${alert.eventId}\n${alert.failures.join("\n")}` } };
  }
  payload = JSON.stringify(payload);
  // Owner-approved delivery acceptance sends one request only. A lost response
  // remains unknown and needs human confirmation, rather than a duplicate test.
  const attempts = alert.failures.length === 1 && alert.failures[0] === "ALERT_DELIVERY_TEST" ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await postAlert(target, payload, { ca, timeoutMs, channel, connectHost });
    if (result.delivered) return { delivered: true, attempts: attempt, eventId: alert.eventId };
    if (!result.retryable || attempt === attempts) return { delivered: false, attempts: attempt, eventId: alert.eventId, errorCode: result.errorCode };
    await delay(250);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const failures = args.filter(arg => arg.startsWith("--backup-failure="));
    if (args.length > 2 || failures.length > 1 || args.filter(arg => arg === "--send").length > 1
      || args.some(arg => arg !== "--send" && !arg.startsWith("--backup-failure="))) throw new Error("ALERT_ARGUMENTS_REJECTED");
    let report;
    if (failures.length) {
      // OnFailure also runs when configuration/preflight failed before a status
      // file could be written. Never reuse an old report or read service logs.
      report = { deploymentId: failures[0].slice("--backup-failure=".length), checkedAt: new Date().toISOString(), failures: ["BACKUP_FAILED"] };
    } else {
      const file = await open(process.env.MQ_ALERT_REPORT_FILE, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 16384) throw new Error("ALERT_REPORT_REJECTED");
        const buffer = Buffer.alloc(16385);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 16384) throw new Error("ALERT_REPORT_REJECTED");
        report = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally { await file.close(); }
    }
    const result = args.includes("--send")
      ? await sendOperationsAlert({ report, webhookUrlFile: process.env.MQ_ALERT_WEBHOOK_URL_FILE,
        channel: process.env.MQ_ALERT_CHANNEL ?? "generic", signingSecretFile: process.env.MQ_ALERT_SIGNING_SECRET_FILE })
      : { dryRun: true, alert: createOperationsAlert(report) };
    console.log(JSON.stringify(result));
    if (result.delivered === false && !result.skipped) process.exitCode = 1;
  } catch { console.error("MQ_ALERT_FAILED"); process.exitCode = 1; }
}
