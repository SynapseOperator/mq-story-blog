import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createOperationsAlert, sendOperationsAlert } from "../scripts/production/alert-webhook.mjs";

const execute = promisify(execFile);
const report = () => ({ deploymentId: randomUUID(), checkedAt: new Date().toISOString(), failures: ["DISK_RESERVE_LOW"] });

test("notification DTO allows fixed codes and drops arbitrary internal content", () => {
  const input = report();
  const result = createOperationsAlert({ ...input, sample: { password: "secret", host: "private-host" }, message: "story text" });
  assert.deepEqual(Object.keys(result).sort(), ["checkedAt", "deploymentId", "eventId", "failures", "version"]);
  assert.doesNotMatch(JSON.stringify(result), /secret|private-host|story text/);
  assert.throws(() => createOperationsAlert({ ...input, failures: ["sensitive-unrecognized-message"] }), { message: "ALERT_REPORT_REJECTED" });
  assert.throws(() => createOperationsAlert({ ...input, checkedAt: "not a time" }), { message: "ALERT_REPORT_REJECTED" });
});

test("OnFailure CLI creates a fresh fixed report even when the status file is absent", async () => {
  const deploymentId = randomUUID(), started = Date.now();
  const result = await execute(process.execPath, ["scripts/production/alert-webhook.mjs", `--backup-failure=${deploymentId}`],
    { windowsHide: true, env: { ...process.env, MQ_ALERT_REPORT_FILE: "must-not-be-read", MQ_ALERT_WEBHOOK_URL_FILE: "must-not-be-read" } });
  const body = JSON.parse(result.stdout);
  assert.equal(body.dryRun, true);
  assert.equal(body.alert.deploymentId, deploymentId);
  assert.deepEqual(body.alert.failures, ["BACKUP_FAILED"]);
  assert.ok(Date.parse(body.alert.checkedAt) >= started);
  assert.equal(result.stderr, "");
  for (const args of [["--backup-failure=invalid"], [`--backup-failure=${deploymentId}`, `--backup-failure=${deploymentId}`], ["--send", "--send"]]) {
    const failure = await execute(process.execPath, ["scripts/production/alert-webhook.mjs", ...args], { windowsHide: true })
      .then(() => assert.fail("expected nonzero"), error => error);
    assert.equal(failure.code, 1); assert.equal(failure.stderr.trim(), "MQ_ALERT_FAILED");
  }
});

test("real local HTTPS delivery, retries, redaction, dry-run and transport failures", async t => {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, "mq-alert-test-"));
  let server;
  try {
    const executable = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl";
    await execute(executable, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "private.pem"),
      "-out", join(directory, "certificate.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
    { windowsHide: true, timeout: 30_000 });
    const key = await readFile(join(directory, "private.pem"));
    const ca = await readFile(join(directory, "certificate.pem"));
    const received = [];
    let mode = "ok";
    server = https.createServer({ key, cert: ca }, async (incoming, outgoing) => {
      let body = "";
      for await (const chunk of incoming) body += chunk.toString("utf8");
      received.push(JSON.parse(body));
      if (mode === "timeout") return;
      if (mode === "redirect") { outgoing.writeHead(302, { location: "https://127.0.0.1/never-follow?private=secret" }); outgoing.end("secret"); }
      else if (mode === "transient") { mode = "ok"; outgoing.writeHead(503); outgoing.end(); }
      else if (["403", "429", "503"].includes(mode)) { outgoing.writeHead(Number(mode)); outgoing.end("secret error body"); }
      else { outgoing.writeHead(204); outgoing.end(); }
    });
    await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
    const webhookUrlFile = join(directory, "webhook-url");
    const webhook = `https://127.0.0.1:${server.address().port}/hook/private-secret?key=do-not-log`;
    await writeFile(webhookUrlFile, webhook, { mode: 0o600 });
    const options = { report: report(), webhookUrlFile, ca };

    await t.test("successful real HTTPS request only contains the allowed envelope", async () => {
      const result = await sendOperationsAlert(options);
      assert.equal(result.delivered, true); assert.equal(result.attempts, 1);
      assert.deepEqual(received.at(-1).failures, options.report.failures);
      assert.equal(received.at(-1).eventId, result.eventId);
      assert.doesNotMatch(JSON.stringify(result), /127\.0|private-secret|do-not-log/);
    });

    await t.test("429 and 503 retry twice with the same event ID; no false success", async () => {
      for (const status of ["429", "503"]) {
        mode = status;
        const start = received.length;
        const result = await sendOperationsAlert(options);
        assert.equal(result.delivered, false); assert.equal(result.attempts, 2);
        assert.equal(result.errorCode, "ALERT_HTTP_REJECTED");
        assert.equal(received.length - start, 2);
        assert.equal(received.at(-1).eventId, received.at(-2).eventId);
        assert.doesNotMatch(JSON.stringify(result), /secret error body/);
      }
    });

    await t.test("redirect is not followed and is not retried", async () => {
      mode = "redirect";
      const start = received.length;
      const result = await sendOperationsAlert(options);
      assert.equal(result.delivered, false); assert.equal(result.attempts, 1);
      assert.equal(result.errorCode, "ALERT_REDIRECT_REJECTED");
      assert.equal(received.length - start, 1);
    });

    await t.test("a temporary outage can recover, while permanent 403 is not retried", async () => {
      mode = "transient";
      const success = await sendOperationsAlert(options);
      assert.equal(success.delivered, true); assert.equal(success.attempts, 2);
      assert.equal(received.at(-1).eventId, received.at(-2).eventId);
      mode = "403";
      const failure = await sendOperationsAlert(options);
      assert.equal(failure.delivered, false); assert.equal(failure.attempts, 1);
    });

    await t.test("missing TLS trust rejects before sending the payload", async () => {
      mode = "ok";
      const start = received.length;
      const result = await sendOperationsAlert({ ...options, ca: undefined });
      assert.equal(result.delivered, false); assert.equal(result.errorCode, "ALERT_TRANSPORT_FAILED");
      assert.equal(received.length, start);
    });

    await t.test("response loss has a bounded timeout and stable retry identity", async () => {
      mode = "timeout";
      const start = received.length, time = Date.now();
      const result = await sendOperationsAlert({ ...options, timeoutMs: 100 });
      assert.equal(result.delivered, false); assert.equal(result.attempts, 2);
      assert.equal(received.length - start, 2);
      assert.equal(received.at(-1).eventId, received.at(-2).eventId);
      assert.ok(Date.now() - time < 5000);
    });

    await t.test("default CLI dry-run sends nothing and does not require a webhook secret", async () => {
      mode = "ok";
      const start = received.length;
      const reportFile = join(directory, "report.json");
      await writeFile(reportFile, JSON.stringify(options.report));
      const result = await execute(process.execPath, ["scripts/production/alert-webhook.mjs"],
        { windowsHide: true, env: { ...process.env, MQ_ALERT_REPORT_FILE: reportFile, MQ_ALERT_WEBHOOK_URL_FILE: "does-not-exist" } });
      assert.equal(JSON.parse(result.stdout).dryRun, true);
      assert.equal(result.stderr, "");
      assert.equal(received.length, start);
    });

    await t.test("explicit CLI send exits nonzero when the real receiver fails", async () => {
      mode = "503";
      const reportFile = join(directory, "report.json");
      await writeFile(reportFile, JSON.stringify(options.report));
      for (const extra of [[], [`--backup-failure=${options.report.deploymentId}`]]) {
        const failure = await execute(process.execPath, ["scripts/production/alert-webhook.mjs", "--send", ...extra],
          { windowsHide: true, env: { ...process.env, MQ_ALERT_REPORT_FILE: extra.length ? "must-not-be-read" : reportFile,
            MQ_ALERT_WEBHOOK_URL_FILE: webhookUrlFile, NODE_EXTRA_CA_CERTS: join(directory, "certificate.pem") } })
          .then(() => assert.fail("expected nonzero"), error => error);
        assert.equal(failure.code, 1);
        const result = JSON.parse(failure.stdout);
        assert.equal(result.delivered, false); assert.equal(result.attempts, 2);
        assert.deepEqual(received.at(-1).failures, extra.length ? ["BACKUP_FAILED"] : options.report.failures);
        assert.doesNotMatch(failure.stdout + failure.stderr, /private-secret|do-not-log|secret error body/);
      }
    });

    await t.test("HTTP, URL userinfo and unknown CLI args fail without leaking values", async () => {
      const start = received.length;
      for (const invalid of ["http://127.0.0.1/no-send", "https://user:secret@localhost/no-send", "https://localhost/no-send#secret"]) {
        await writeFile(webhookUrlFile, invalid, { mode: 0o600 });
        await assert.rejects(sendOperationsAlert(options), { message: "ALERT_CONFIG_REJECTED" });
      }
      const failure = await execute(process.execPath, ["scripts/production/alert-webhook.mjs", "--token=never-print"], { windowsHide: true })
        .then(() => assert.fail("expected nonzero"), error => error);
      assert.equal(failure.code, 1); assert.equal(failure.stderr.trim(), "MQ_ALERT_FAILED");
      assert.doesNotMatch(failure.stdout + failure.stderr, /never-print/);
      assert.equal(received.length, start);
    });

    await t.test("healthy report does not read a secret or contact the receiver", async () => {
      const start = received.length;
      const result = await sendOperationsAlert({ report: { ...report(), failures: [] }, webhookUrlFile: "absent" });
      assert.equal(result.skipped, "NO_ALERTS"); assert.equal(result.attempts, 0);
      assert.equal(received.length, start);
    });
  } finally {
    if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    assert.equal(dirname(resolve(directory)), parent);
    assert.match(basename(directory), /^mq-alert-test-/);
    await rm(directory, { recursive: true });
  }
});
