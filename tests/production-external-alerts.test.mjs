import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { URL } from "node:url";
import { sendOperationsAlert } from "../scripts/production/alert-webhook.mjs";
import { collectExternalAvailability } from "../scripts/production/operations-check.mjs";

const execute = promisify(execFile);

test("external availability and signed Feishu adapter use a real isolated HTTPS receiver", async t => {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, "mq-external-alert-"));
  let server;
  try {
    const executable = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl";
    await execute(executable, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "private.pem"),
      "-out", join(directory, "certificate.pem"), "-days", "30", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:open.feishu.cn"], { windowsHide: true, timeout: 30000 });
    const key = await readFile(join(directory, "private.pem")), ca = await readFile(join(directory, "certificate.pem"));
    const received = []; let mode = "ok", requests = 0, expectedHost;
    server = https.createServer({ key, cert: ca }, async (incoming, outgoing) => {
      requests++;
      if (incoming.url === "/api/stories") {
        if (expectedHost) {
          assert.equal(incoming.headers.host, expectedHost);
          assert.equal(incoming.socket.servername, "localhost");
        }
        assert.equal(incoming.method, "GET"); assert.equal(incoming.headers.cookie, undefined);
        assert.equal(incoming.headers.authorization, undefined);
        if (mode === "timeout") return;
        if (mode === "redirect") { outgoing.writeHead(302, { location: "https://never-contact.invalid/private" }); outgoing.end(); return; }
        outgoing.writeHead(mode === "unavailable" ? 503 : 200, { "content-type": mode === "html" ? "text/html" : "application/json" });
        outgoing.end(mode === "oversize" ? "x".repeat(65537) : mode === "malformed" ? "not JSON" : JSON.stringify({ stories: [], private: "must-not-escape" }));
        return;
      }
      assert.match(incoming.url, /^\/open-apis\/bot\/v2\/hook\//);
      let body = ""; for await (const chunk of incoming) body += chunk.toString("utf8");
      received.push(JSON.parse(body));
      if (mode === "timeout") return;
      if (mode === "transient") { mode = "ok"; outgoing.writeHead(503); outgoing.end("private transport details"); return; }
      if (mode === "redirect") { outgoing.writeHead(302, { location: "https://never-contact.invalid/private" }); outgoing.end(); return; }
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(mode === "oversize" ? "x".repeat(4097) : mode === "malformed" ? "not JSON"
        : JSON.stringify({ code: mode === "rejected" ? 19021 : 0, msg: "private receiver detail" }));
    });
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const port = server.address().port;
    const origin = `https://127.0.0.1:${port}`;

    await t.test("external probe detects healthy TLS plus application, without exposing public body", async () => {
      const result = await collectExternalAvailability({ origin, ca });
      assert.equal(result.ok, true); assert.equal(result.sample.httpAvailable, true);
      assert.ok(result.sample.certificateDays > 29); assert.doesNotMatch(JSON.stringify(result), /must-not-escape/);
    });

    await t.test("a loopback tunnel preserves the target Host and TLS server name", async () => {
      expectedHost = `localhost:${port}`;
      const result = await collectExternalAvailability({ origin: `https://${expectedHost}`, ca, connectHost: "127.0.0.1" });
      assert.equal(result.ok, true);
      expectedHost = undefined;
    });

    await t.test("503, non-JSON, malformed, oversized, redirects and timeout are not healthy", async () => {
      for (const value of ["unavailable", "html", "malformed", "oversize", "redirect", "timeout"]) {
        mode = value; const started = requests;
        const result = await collectExternalAvailability({ origin, ca, timeoutMs: 100 });
        assert.equal(result.ok, false); assert.ok(result.failures.includes("HTTPS_UNAVAILABLE"));
        assert.equal(requests - started, 1, "No redirect or hidden retry");
        assert.doesNotMatch(JSON.stringify(result), /private|never-contact|must-not-escape/);
      }
      mode = "ok";
      const before = requests;
      const untrusted = await collectExternalAvailability({ origin });
      assert.deepEqual(untrusted.failures, ["TLS_EXPIRY_OR_VERIFICATION_FAILED", "HTTPS_UNAVAILABLE"]);
      assert.equal(requests, before);
    });

    await t.test("external CLI works without Docker or host credentials and exits nonzero on failure", async () => {
      const env = { ...process.env, MQ_OPS_DEPLOYMENT_ID: randomUUID(), MQ_OPS_ORIGIN: origin,
        NODE_EXTRA_CA_CERTS: join(directory, "certificate.pem"), MQ_OPS_PROJECT: "not-read-in-external-mode" };
      mode = "ok";
      const success = await execute(process.execPath, ["scripts/production/operations-check.mjs", "--external"], { env, windowsHide: true });
      assert.equal(JSON.parse(success.stdout).check, "mq-external"); assert.equal(JSON.parse(success.stdout).ok, true);
      mode = "unavailable";
      const failure = await execute(process.execPath, ["scripts/production/operations-check.mjs", "--external"], { env, windowsHide: true })
        .then(() => assert.fail("Expected nonzero"), error => error);
      assert.equal(failure.code, 1); assert.ok(JSON.parse(failure.stdout).failures.includes("HTTPS_UNAVAILABLE"));
      assert.doesNotMatch(failure.stdout + failure.stderr, /must-not-escape/);
      const preview = await execute(process.execPath, ["scripts/production/monitor-runner.mjs", "--external"], {
        env: { ...env, MQ_ALERT_WEBHOOK_URL_FILE: "must-not-read-or-send", MQ_ALERT_SIGNING_SECRET_FILE: "must-not-read-or-send" }, windowsHide: true,
      }).then(() => assert.fail("Probe outage remains nonzero even when notification is a preview"), error => error);
      assert.equal(preview.code, 1);
      const records = preview.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.equal(records[0].ok, false); assert.equal(records[1].dryRun, true);
      assert.deepEqual(records[1].alert.failures, ["HTTPS_UNAVAILABLE"]); assert.equal(received.length, 0);
    });

    const webhookUrlFile = join(directory, "webhook"), signingSecretFile = join(directory, "signing");
    const signingSecret = "synthetic-feishu-signing-key-for-test-only";
    const webhook = `https://open.feishu.cn:${port}/open-apis/bot/v2/hook/synthetic-key-not-real`;
    await writeFile(webhookUrlFile, webhook, { mode: 0o600 }); await writeFile(signingSecretFile, signingSecret, { mode: 0o600 });
    const report = { deploymentId: randomUUID(), checkedAt: new Date().toISOString(), failures: ["HTTPS_UNAVAILABLE", "BACKUP_MISSING_OR_STALE"],
      message: "private-data-must-not-escape" };
    const options = { report, channel: "feishu", webhookUrlFile, signingSecretFile, ca, connectHost: "127.0.0.1" };

    await t.test("Feishu accepts only signed text with safe codes and explicit code=0 acknowledgement", async () => {
      mode = "ok";
      const result = await sendOperationsAlert(options), body = received.at(-1);
      assert.equal(result.delivered, true); assert.equal(body.msg_type, "text");
      assert.equal(body.sign, createHmac("sha256", `${body.timestamp}\n${signingSecret}`).update("").digest("base64"));
      assert.ok(Math.abs(Number(body.timestamp) - Math.floor(Date.now() / 1000)) <= 5);
      assert.match(body.content.text, /MQ 运维告警/); assert.ok(body.content.text.includes(result.eventId));
      assert.doesNotMatch(body.content.text, /private-data|synthetic-feishu|<at|@/);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-key|private receiver|signing|open\.feishu/);
    });

    await t.test("HTTP 200 rejection and malformed acknowledgements cannot masquerade as delivery", async () => {
      for (const value of ["rejected", "malformed", "oversize"]) {
        mode = value;
        const result = await sendOperationsAlert(options);
        assert.equal(result.delivered, false); assert.equal(result.errorCode, "ALERT_ACK_REJECTED"); assert.equal(result.attempts, 1);
        assert.doesNotMatch(JSON.stringify(result), /private receiver detail/);
      }
    });

    await t.test("owner delivery test is clearly marked and never automatically retried", async () => {
      const testOptions = { ...options, report: { ...report, failures: ["ALERT_DELIVERY_TEST"] } };
      mode = "ok";
      const success = await sendOperationsAlert(testOptions);
      assert.equal(success.delivered, true);
      assert.match(received.at(-1).content.text, /送达测试（非故障）/);
      assert.doesNotMatch(received.at(-1).content.text, /HTTPS_UNAVAILABLE|private-data|<at|@/);
      for (const value of ["transient", "timeout"]) {
        mode = value;
        const start = received.length;
        const failure = await sendOperationsAlert({ ...testOptions, timeoutMs: 100 });
        assert.equal(failure.delivered, false);
        assert.equal(failure.attempts, 1);
        assert.equal(failure.errorCode, value === "timeout" ? "ALERT_TRANSPORT_FAILED" : "ALERT_HTTP_REJECTED");
        assert.equal(received.length - start, 1, "An accepted request with no response must not cause a duplicate test notification");
      }
    });

    await t.test("transient retry preserves identity and signature, while redirects are rejected", async () => {
      mode = "transient";
      const result = await sendOperationsAlert(options);
      assert.equal(result.delivered, true); assert.equal(result.attempts, 2);
      assert.deepEqual(received.at(-1), received.at(-2));
      mode = "redirect";
      const rejected = await sendOperationsAlert(options);
      assert.equal(rejected.delivered, false); assert.equal(rejected.errorCode, "ALERT_REDIRECT_REJECTED"); assert.equal(rejected.attempts, 1);
    });

    await t.test("Feishu secret, channel and destination must be explicit, with safe configuration failures", async () => {
      const before = received.length;
      for (const replacement of [{ signingSecretFile: undefined }, { channel: "unknown" }, { channel: "generic" }]) {
        await assert.rejects(sendOperationsAlert({ ...options, ...replacement }), { message: "ALERT_CONFIG_REJECTED" });
      }
      for (const destination of ["https://unapproved.invalid/open-apis/bot/v2/hook/synthetic-key-not-real", `${webhook}?secret=private`, `${webhook}#private`]) {
        await writeFile(webhookUrlFile, destination);
        await assert.rejects(sendOperationsAlert(options), { message: "ALERT_CONFIG_REJECTED" });
      }
      assert.equal(received.length, before);
    });
  } finally {
    if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    assert.equal(dirname(resolve(directory)), parent); assert.match(basename(directory), /^mq-external-alert-/);
    await rm(directory, { recursive: true });
  }
});

test("monitor templates use the installed Node runtime and do not enable outbound notifications", async () => {
  for (const file of ["mq-monitor@.service", "mq-backup@.service", "mq-backup-alert@.service"]) {
    const content = await readFile(new URL(`../ops/${file}`, import.meta.url), "utf8");
    assert.match(content, /ExecStart=\/opt\/mq\/node-v24\.19\.0\/bin\/node /);
    assert.doesNotMatch(content, /^ExecStart=.* --send/m);
  }
  const timer = await readFile(new URL("../ops/mq-monitor@.timer", import.meta.url), "utf8");
  assert.match(timer, /OnUnitActiveSec=5m/);
});
