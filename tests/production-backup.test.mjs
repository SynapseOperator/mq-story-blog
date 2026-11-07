import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { backupBackend, initializeBackupRepository, readS3CredentialsEnvironment, requireBackupSpace, runBackupTool, restic } from "../scripts/production/backup-tools.mjs";

test("backup child failures and output overflow never expose child diagnostics", async () => {
  const secret = "synthetic-diagnostic-must-not-escape";
  for (const args of [["-e", `process.stderr.write('${secret}'); process.exit(3)`],
    ["-e", "process.stdout.write(Buffer.alloc(5*1024*1024))"]]) {
    await assert.rejects(runBackupTool(process.execPath, args), error => error.message === "BACKUP_TOOL_FAILED" && !error.cause);
  }
  await assert.rejects(runBackupTool("mq-missing-backup-tool", []), { message: "BACKUP_TOOL_FAILED" });
});

test("interrupted dump stops writing before the failed operation returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-backup-tool-"));
  const output = join(directory, "partial.dump");
  try {
    await assert.rejects(runBackupTool(process.execPath,
      ["-e", "process.stdout.write('partial');setInterval(()=>process.stdout.write('chunk'),25)"],
      { output, timeoutMs: 1000 }), { message: "BACKUP_TOOL_FAILED" });
    const stopped = await readFile(output);
    assert.ok(stopped.length > 0, "The child must have written actual partial data before interruption");
    await delay(100);
    assert.deepEqual(await readFile(output), stopped, "No child remains writing after a failure");
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())));
    await rm(directory, { recursive: true });
  }
});

test("Restic rejects mutable snapshot aliases, nonempty restore targets and unsupported commands before running a binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-restic-boundary-"));
  const repository = join(directory, "repo"), target = join(directory, "target"), passwordFile = join(directory, "password");
  await mkdir(repository, { mode: 0o700 }); await mkdir(target, { mode: 0o700 });
  await writeFile(passwordFile, "a".repeat(64), { mode: 0o600 });
  await writeFile(join(target, "must-survive"), "existing", { mode: 0o600 });
  try {
    const options = { repository, passwordFile };
    for (const args of [["restore", "latest:/payload", "--target", target, "--verify"],
      ["restore", `${"a".repeat(64)}:/payload`, "--target", target, "--verify"], ["forget", "--prune"], ["unlock"],
      ["forget", "--dry-run", "--prune"], ["prune", "--dry-run"],
      ["forget", "--json", "--host", "mq-00000000-0000-4000-8000-000000000000", "--keep-daily", "7"]]) {
      await assert.rejects(restic(args, options), { message: "BACKUP_RESTIC_FAILED" });
    }
    assert.equal(await readFile(join(target, "must-survive"), "utf8"), "existing");
  } finally { await rm(directory, { recursive: true }); }
});

test("S3 requires an explicit HTTPS backend, dedicated prefix and pinned repository identity", async () => {
  const options = { backend: "s3", repository: "s3:https://storage.example.invalid/mq-backup/deployment-one",
    expectedRepositoryId: "a".repeat(64), s3: { region: "us-east-1", credentialsFile: join(tmpdir(), "synthetic-s3-secret") } };
  assert.equal(backupBackend(options), "s3");
  assert.equal(backupBackend({ repository: tmpdir() }), "local", "Existing internal local callers stay local");
  for (const replacement of [
    { backend: "local" }, { backend: "unknown" }, { expectedRepositoryId: undefined }, { expectedRepositoryId: "latest" },
    { repository: "s3:http://storage.example.invalid/mq-backup/deployment-one" },
    { repository: "s3:https://name:secret@storage.example.invalid/mq-backup/deployment-one" },
    { repository: "s3:https://storage.example.invalid/mq-backup/deployment-one?secret=private" },
    { repository: "s3:https://storage.example.invalid/mq-backup/" },
    { repository: "s3:https://storage.example.invalid/mq-backup/prefix/../other" },
    { repository: "s3:https://storage.example.invalid/mq-backup/prefix%2fother" },
    { s3: { ...options.s3, extraOptions: "unsafe-anonymous-auth=true" } },
    { s3: { ...options.s3, region: "us-east-1\n-o unsafe" } },
    { s3: { ...options.s3, credentialsFile: "relative-secret" } },
  ]) assert.throws(() => backupBackend({ ...options, ...replacement }), { message: "BACKUP_BACKEND_REJECTED" });
  await assert.rejects(initializeBackupRepository(options), { message: "BACKUP_S3_INIT_REQUIRES_SEPARATE_PROVISIONING" });
});

test("S3 JSON secrets produce only explicit child AWS credentials and reject profiles or executable fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mq-s3-credentials-"));
  const secretFile = join(directory, "credentials.json");
  const values = { accessKeyId: "SYNTHETICACCESSKEY", secretAccessKey: "synthetic-not-a-real-secret", sessionToken: "synthetic-session" };
  try {
    await writeFile(secretFile, JSON.stringify(values), { mode: 0o600 });
    const environment = await readS3CredentialsEnvironment(secretFile);
    assert.deepEqual(Object.keys(environment).sort(), ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]);
    assert.equal(environment.AWS_ACCESS_KEY_ID, values.accessKeyId);
    assert.equal(environment.AWS_SECRET_ACCESS_KEY, values.secretAccessKey);
    assert.equal(environment.AWS_SESSION_TOKEN, values.sessionToken);
    // Inspect field names and booleans only; never print credential values.
    const child = JSON.parse(await runBackupTool(process.execPath, ["-e", `process.stdout.write(JSON.stringify({
      aws:Object.keys(process.env).filter(k=>k.startsWith('AWS_')).sort(),
      minio:Object.keys(process.env).some(k=>k.startsWith('MINIO_')),
      correct:process.env.AWS_ACCESS_KEY_ID==='SYNTHETICACCESSKEY'}))`], { env: environment }));
    assert.deepEqual(child, { aws: Object.keys(environment).sort(), minio: false, correct: true });
    for (const invalid of [null, [], {}, { ...values, role: "admin" }, { ...values, credential_process: "arbitrary-command" },
      { ...values, secretAccessKey: "" }, { ...values, sessionToken: "line\nbreak" }, { ...values, accessKeyId: 123 },
      { ...values, secretAccessKey: "x".repeat(5000) }]) {
      await writeFile(secretFile, JSON.stringify(invalid));
      await assert.rejects(readS3CredentialsEnvironment(secretFile), { message: "BACKUP_S3_CREDENTIALS_REJECTED" });
    }
    await writeFile(secretFile, JSON.stringify({ accessKeyId: values.accessKeyId, secretAccessKey: values.secretAccessKey }));
    assert.equal(Object.hasOwn(await readS3CredentialsEnvironment(secretFile), "AWS_SESSION_TOKEN"), false);
    if (process.platform !== "win32") {
      await chmod(secretFile, 0o644);
      await assert.rejects(readS3CredentialsEnvironment(secretFile), { message: "BACKUP_S3_CREDENTIALS_REJECTED" });
      await chmod(secretFile, 0o600);
    }
    await assert.rejects(requireBackupSpace(directory, Number.MAX_SAFE_INTEGER), { message: "BACKUP_DISK_SPACE_LOW" });
  } finally { await rm(directory, { recursive: true }); }
});

test("R2 uses account-scoped HTTPS, auto region and system trust without weakening generic S3 labs", () => {
  const options = { backend: "s3", repository: `s3:https://${"a".repeat(32)}.r2.cloudflarestorage.com/mq-private-backup/production`,
    expectedRepositoryId: "b".repeat(64), s3: { region: "auto", credentialsFile: join(tmpdir(), "synthetic-r2-file") } };
  assert.equal(backupBackend(options), "s3");
  assert.equal(backupBackend({ ...options, repository: options.repository.replace(".r2.", ".eu.r2.") }), "s3");
  for (const replacement of [
    { repository: options.repository.replace("a".repeat(32), "unknown-account") },
    { repository: options.repository.replace(".com/", ".com:8443/") },
    { s3: { ...options.s3, region: "us-east-1" } },
    { s3: { ...options.s3, caCertificateFile: join(tmpdir(), "unapproved-ca") } },
  ]) assert.throws(() => backupBackend({ ...options, ...replacement }), { message: "BACKUP_BACKEND_REJECTED" });
  assert.equal(backupBackend({ ...options, repository: "s3:https://mq-backup.localhost/mq-lab/synthetic",
    s3: { ...options.s3, region: "us-east-1", caCertificateFile: join(tmpdir(), "lab-ca") } }), "s3");
});
