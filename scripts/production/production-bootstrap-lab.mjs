import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validateDeploymentConfig, LOGIN_IDENTITIES } from "./database-config.mjs";
import { runProductionHttpChecks, laboratoryTransport } from "./http-tests.mjs";
import { releaseCompatibility, sha256, TARGETS } from "../release/bundle.mjs";
import { planProductionBootstrap, planProductionChange, planProductionPrivatePreview, planProductionPreviewClose,
  planProductionActivation, executeProductionPlan } from "../release/production-plan.mjs";
import { privateHttpsHealthy } from "../release/production-host.mjs";
import { runProductionRecovery } from "./production-recovery-lab.mjs";
import { runPrivatePreviewChecks } from "./private-preview-lab.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const reserve = 8 * 1024 ** 3;
let stage = "prepare isolated production-contract laboratory";
async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}

async function main() {
  const privatePreview = process.argv.length === 3 && process.argv[2] === "--private-preview";
  assert.ok(process.argv.length === 2 || privatePreview);
  const id = randomUUID(), suffix = id.replaceAll("-", ""), project = `mq-p502-${suffix}`;
  const previewBrowserImage = `${project}-browser:local`;
  const directory = await mkdtemp(join(tmpdir(), "mq-p502-production-"));
  const evidence = process.env.PRODUCTION_BOOTSTRAP_EVIDENCE_DIR || join(directory, "evidence");
  await mkdir(evidence, { recursive: true });
  console.log(`Synthetic production-contract evidence: ${evidence}`);
  const secrets = new Set(), secret = () => { const value = randomBytes(32).toString("hex"); secrets.add(value); return value; };
  const docker = (args, { fail = true, timeout = 300000 } = {}) => {
    const result = spawnSync("docker", args, { cwd: root, windowsHide: true, encoding: "utf8", timeout, maxBuffer: 16 * 1024 ** 2 });
    // Never surface raw Docker output: fixtures contain synthetic passwords and
    // session data, held to the same log policy as the production commands.
    if (fail && (result.error || result.status !== 0)) throw new Error("PRODUCTION_CONTRACT_DOCKER_FAILED");
    return result;
  };
  const images = Object.fromEntries(TARGETS.map(name => [name, process.env[`MQ_LAB_${name.toUpperCase()}_IMAGE`]
    || (name === "operations" ? "mq-p303-operations:local" : `mq-p302-${name}:local`)]));
  const port = await unusedPort(), origin = privatePreview ? "https://mq-story.xyz" : `https://mq.localhost:${port}`;
  const manifest = { version: 1, environment: "production", deploymentId: id,
    database: { host: "postgres", port: 5432, name: "mq_production" }, origin,
    media: { root: "/var/lib/mq/media", minFreeBytes: reserve } };
  const config = validateDeploymentConfig(manifest);
  const passwords = Object.fromEntries(LOGIN_IDENTITIES.map(name => [name, secret()])), bootstrapPassword = secret();
  const url = identity => `postgresql://${identity === "bootstrap" ? "mq_bootstrap" : config.roles[identity]}:${identity === "bootstrap" ? bootstrapPassword : passwords[identity]}@postgres:5432/mq_production`;
  const files = { postgres_password: bootstrapPassword, database_url: url("runtime"), bootstrap_database_url: url("bootstrap"),
    migration_database_url: url("migration"), maintenance_database_url: url("maintenance"), backup_database_url: url("backup"),
    role_passwords: JSON.stringify(passwords), auth_secret: secret(), session_storage_key: secret(), auth_proxy_secret: secret(), publish_signing_key: secret(), comment_signing_key: secret(), restic_password: secret() };
  const accounts = { admin: { username: `lab_admin_${suffix.slice(0, 8)}`, password: `MqLab!${secret()}` },
    reader: { username: `lab_reader_${suffix.slice(0, 8)}`, password: `MqReader!${secret()}` } };
  files.accounts = JSON.stringify(accounts);
  Object.values(files).forEach(value => secrets.add(value));
  secrets.add(accounts.admin.password); secrets.add(accounts.reader.password);
  const volumes = {}, helpers = new Set();
  async function volume(name, entries, uid = 10001) {
    const full = `${project}_${name}`; volumes[name] = full;
    docker(["volume", "create", "--label", `mq.lab=${id}`, full]);
    const staged = await mkdtemp(join(directory, `${name}-`));
    for (const [file, bytes] of Object.entries(entries)) await writeFile(join(staged, file), bytes, { mode: 0o600 });
    const helper = `${project}-copy-${name}`; helpers.add(helper);
    docker(["create", "--name", helper, "--network", "none", "--user", "0:0", "--mount", `type=volume,source=${full},target=/target`,
      "--mount", "type=tmpfs,destination=/var/lib/postgresql,tmpfs-size=1048576", "--entrypoint", "/bin/sh", images.tools, "-c",
      `cp -R /staged/. /target/ && chown -R ${uid}:${uid} /target && chmod 0700 /target && find /target -type f -exec chmod ${name === "manifest" ? "0444" : "0400"} {} +`]);
    docker(["cp", `${staged}${process.platform === "win32" ? "\\" : "/"}.`, `${helper}:/staged`]);
    docker(["start", "--attach", helper]); docker(["rm", helper]); helpers.delete(helper);
  }
  const envFile = join(directory, "compose.env"), overrideFile = join(directory, "isolated.yaml"), transportFile = join(directory, "transport.yaml");
  const composeBase = ["compose", "--project-name", project, "--env-file", envFile, "-f", join(root, "compose.production.yaml"), "-f", overrideFile];
  const compose = (args, options) => docker([...composeBase, ...args], options);
  const transport = args => docker([...composeBase, "-f", transportFile, ...args]);
  const service = name => compose(["ps", "-q", name]).stdout.trim();
  const json = result => JSON.parse(result.stdout.trim());
  const disabled = { auth: false, media: false, publishing: false, comments: false };
  const enabled = Object.fromEntries(Object.keys(disabled).map(name => [name, true]));
  const writeEnvironment = async features => {
    await writeFile(envFile, Object.entries({ MQ_DEPLOYMENT_ENV: "production", MQ_DATABASE_NAME: "mq_production", MQ_AUTH_ORIGIN: origin,
      MQ_PUBLIC_HOST: new URL(origin).hostname, MQ_DEPLOYMENT_CONFIG: join(directory, "deployment.json").replaceAll("\\", "/"),
      MQ_SECRET_DIRECTORY: directory.replaceAll("\\", "/"), MQ_APP_IMAGE: images.app, MQ_TOOLS_IMAGE: images.tools, MQ_PROXY_IMAGE: images.proxy,
      MQ_AUTH_ENABLED: String(features.auth), MQ_MEDIA_ENABLED: String(features.media), MQ_PUBLISH_ENABLED: String(features.publishing), MQ_COMMENTS_ENABLED: String(features.comments),
    }).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
  };
  const operation = (name, group, environment = {}, { fixture = false, extra = [], fail = true } = {}) => {
    stage = `${fixture ? "fixture" : "database"}/${name}`;
    const args = ["run", "--rm", "--no-deps", "-v", `${volumes[group]}:/run/secrets:ro`];
    for (const [key, value] of Object.entries(environment)) args.push("-e", `${key}=${value}`);
    return compose([...args, "tools",
      fixture ? "tests/fixtures/production-bootstrap-actions.mjs" : "scripts/production/database-cli.mjs", name,
      ...(!fixture && name !== "audit" ? [`--confirm-production=${id}`] : []), ...extra], { fail });
  };
  const fixture = (name, group = "maintenance", env = {}) => operation(name, group, env, { fixture: true });
  const dbOperation = name => {
    const group = name === "audit" ? "app" : name === "migrate" ? "migration" : name === "keys" ? "keys" : "bootstrap";
    const environment = { bootstrap: { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url", MQ_ROLE_PASSWORDS_FILE: "/run/secrets/role_passwords" },
      keys: { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url", MQ_PUBLISH_SIGNING_KEY_FILE: "/run/secrets/publish_signing_key", MQ_COMMENT_SIGNING_KEY_FILE: "/run/secrets/comment_signing_key" },
      migration: { MIGRATION_DATABASE_URL_FILE: "/run/secrets/migration_database_url" }, app: { RUNTIME_DATABASE_URL_FILE: "/run/secrets/database_url" } };
    return operation(name, group, environment[group]);
  };
  let succeeded = false, configured = false, previewCa, previewWrongCa, preview;
  const checks = [];
  const pass = name => { checks.push(name); console.log(`PASS production contract: ${name}`); };
  try {
    for (const image of Object.values(images)) docker(["image", "inspect", image]);
    await writeFile(join(directory, "deployment.json"), JSON.stringify(manifest));
    await volume("manifest", { "deployment.json": JSON.stringify(manifest) });
    for (const [name, names, uid] of [["app", ["database_url", "auth_secret", "session_storage_key", "auth_proxy_secret", "publish_signing_key", "comment_signing_key"]],
      ["pg", ["postgres_password"], 999], ["proxy", ["auth_proxy_secret"]], ["bootstrap", ["bootstrap_database_url", "role_passwords"]],
      ["migration", ["migration_database_url"]], ["keys", ["bootstrap_database_url", "publish_signing_key", "comment_signing_key"]],
      ["maintenance", ["maintenance_database_url", "accounts"]], ["backup", ["bootstrap_database_url", "backup_database_url", "restic_password"]], ["operations", []]]) {
      await volume(name, Object.fromEntries(names.map(key => [key, files[key]])), uid);
    }
    if (privatePreview) {
      stage = "prepare disposable preview certificates";
      await volume("preview", {});
      docker(["run", "--rm", "--network", "none", "--mount", `type=volume,source=${volumes.preview},target=/certificates`,
        "--mount", `type=volume,source=${volumes.proxy},target=/proxy`, "--entrypoint", "/bin/sh", images.tools, "-eu", "-c", `
        umask 077
        cd /certificates
        openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=MQ isolated preview CA' -keyout ca.key -out ca.pem
        openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=MQ unrelated CA' -keyout wrong.key -out wrong.pem
        openssl req -new -newkey rsa:2048 -nodes -subj '/CN=mq-story.xyz' -keyout server.key -out server.csr
        printf '%s\\n' 'subjectAltName=DNS:mq-story.xyz' 'extendedKeyUsage=serverAuth' 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' > server.ext
        openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile server.ext -out server.pem
        cp server.pem /proxy/preview_certificate
        cp server.key /proxy/preview_private_key
        chmod 0400 /proxy/preview_certificate /proxy/preview_private_key
      `]);
      const certRead = name => docker(["run", "--rm", "--network", "none", "--mount", `type=volume,source=${volumes.preview},target=/certificates,readonly`,
        "--entrypoint", "cat", images.tools, `/certificates/${name}`]).stdout;
      previewCa = certRead("ca.pem"); previewWrongCa = certRead("wrong.pem");
      preview = { version: 1, host: "127.0.0.1", port, ...Object.fromEntries([["ca", "ca.pem"], ["certificate", "server.pem"], ["privateKey", "server.key"]].map(([name, file]) => [name, {
        path: `/isolated-preview/${file}`, sha256: docker(["run", "--rm", "--network", "none", "--mount", `type=volume,source=${volumes.preview},target=/certificates,readonly`,
          "--entrypoint", "sha256sum", images.tools, `/certificates/${file}`]).stdout.trim().split(/\s+/)[0],
      }])) };
      docker(["build", "--file", "tests/fixtures/Dockerfile.private-preview-browser", "--tag", previewBrowserImage, "."], { timeout: 600000 });
    }
    await writeEnvironment(disabled);
    await writeFile(overrideFile, `services:
  postgres:
    secrets: !reset []
    volumes: ["pg:/run/secrets:ro"]
  app:
    restart: "no"
    configs: !reset []
    secrets: !reset []
    volumes: ["manifest:/etc/mq:ro", "app:/run/secrets:ro"]
  proxy:
    restart: "no"
    secrets: !reset []
    volumes: ["proxy:/run/secrets:ro"]
    ports: !reset []
  tools:
    configs: !reset []
    volumes: ["manifest:/etc/mq:ro"]
    environment:
      MQ_SYNTHETIC_LAB: "true"
      MQ_SYNTHETIC_DEPLOYMENT_ID: ${id}
volumes:
${Object.entries(volumes).map(([name, full]) => `  ${name}: { external: true, name: ${full} }`).join("\n")}
`);
    await writeFile(transportFile, `services:\n  proxy:\n    environment:\n      MQ_DEPLOYMENT_ENV: ${privatePreview ? "production" : "staging"}\n      MQ_TLS_MODE: ${privatePreview ? "private" : "local"}\n    ports: !override ["127.0.0.1:${port}:443"]\n`);
    configured = true;
    const sourceSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    // Explicit test fixture for the planner, not evidence of real release
    // approval/OCI verification. The normal release candidate suite covers it.
    const release = { version: 1, platform: "linux/amd64", sourceSha, gate: { kind: "reviewed-main", sourceSha },
      compatibility: await releaseCompatibility(root), images: Object.fromEntries(TARGETS.map(name => [name,
        { indexDigest: json(docker(["image", "inspect", images[name], "--format", "{{json .Id}}"] )) }])) };
    const digest = sha256(JSON.stringify(release));
    let receipt;
    const execute = async (step, plan) => {
      stage = `${plan.action}/${step}`;
      switch (step) {
        case "preflight": {
          const spec = json(compose(["config", "--format", "json"]));
          assert.equal(spec.services.app.environment.MQ_DEPLOYMENT_ENV, "production");
          assert.equal(spec.services.postgres.environment.POSTGRES_DB, "mq_production");
          assert.ok(Object.values(spec.services).every(service => !service.ports?.length));
          const capacity = json(docker(["run", "--rm", "--network", "none", "--read-only", images.tools, "--input-type=module", "--eval",
            "import {statfs} from 'node:fs/promises';const s=await statfs('/');console.log(JSON.stringify({freeBytes:s.bavail*s.bsize}));"]));
          console.log(`Synthetic capacity: ${JSON.stringify({ freeBytes: capacity.freeBytes, reserveBytes: reserve })}`);
          assert.ok(capacity.freeBytes >= reserve, "SYNTHETIC_DISK_RESERVE_REQUIRED");
          return true;
        }
        case "postgres": compose(["up", "-d", "--wait", "--wait-timeout", "180", "postgres"]); return;
        case "bootstrap": case "migrate": case "provision": case "keys": case "audit": dbOperation(step); return;
        case "volumes-init": compose(["run", "--rm", "--no-deps", "volumes-init"]); return;
        case "media-init": compose(["run", "--rm", "--no-deps", "tools", "scripts/production/init-media.mjs"]); return;
        case "close-ingress": compose(["stop", "proxy"]); return;
        case "stop-app": compose(["stop", "app"]); return;
        case "app": await writeEnvironment(plan.features); compose(["up", "-d", "--wait", "--wait-timeout", "180", "app"]); return;
        case "health": compose(["exec", "-T", "app", "node", "scripts/production/healthcheck.mjs"]); return true;
        case "open-private-ingress": transport(["up", "-d", "--wait", "--wait-timeout", "180", "proxy"]); return;
        case "private-https": return privateHttpsHealthy({ origin, preview: plan.preview, ca: Buffer.from(previewCa) });
        case "pause-preview-writers": case "revoke-preview-sessions": case "resume-preview-writers":
          fixture(step, "bootstrap", { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url" }); return;
        case "receipt": receipt = { version: 1, verified: true, action: plan.action, deploymentId: id, sourceSha,
          release, candidateManifestSha256: digest, planId: plan.planId, features: plan.features, publicIngress: false,
          ...(plan.action === "private-preview" ? { privateIngress: true, preview: plan.preview } : {}),
          ...(plan.action === "close-preview" ? { privateIngress: false, previewSessionsRevoked: true } : {}), completedAt: new Date().toISOString() };
          await writeFile(join(evidence, `${plan.action}-receipt.json`), JSON.stringify(receipt)); return receipt;
        default: throw new Error("FIXTURE_UNKNOWN_STEP");
      }
    };
    const apply = (plan, runner = execute) => executeProductionPlan({ plan, approval: { version: 1, action: plan.action,
      deploymentId: id, sourceSha, planId: plan.planId, approvedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() },
      confirmation: `${plan.action}:${id}:${plan.planId}`, execute: runner });
    const bootstrap = planProductionBootstrap({ release, config: manifest, candidateManifestSha256: digest });
    await apply(bootstrap);
    fixture("empty", "bootstrap", { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url" });
    assert.equal(service("proxy"), "");
    for (const name of ["app", "postgres"]) {
      const bindings = json(docker(["inspect", service(name), "--format", "{{json .HostConfig.PortBindings}}"]));
      assert.ok(!bindings || Object.keys(bindings).length === 0);
    }
    assert.equal(docker(["exec", service("app"), "id", "-u"]).stdout.trim(), "10001");
    docker(["exec", service("app"), "/bin/sh", "-eu", "-c",
      'for tool in npm npx yarn yarnpkg corepack; do if command -v "$tool" >/dev/null 2>&1; then exit 1; fi; done; test ! -d /usr/local/lib/node_modules/npm; test ! -d /usr/local/lib/node_modules/corepack']);
    const appEnv = json(docker(["inspect", service("app"), "--format", "{{json .Config.Env}}"]));
    for (const name of ["AUTH", "MEDIA", "PUBLISH", "COMMENTS"]) assert.ok(appEnv.includes(`MQ_${name}_ENABLED=false`));
    pass("empty production database, 001–009, exact permissions, disabled business and no ingress");
    const localProductionTls = compose(["run", "--rm", "--no-deps", "-e", "MQ_TLS_MODE=local", "proxy"], { fail: false });
    assert.equal(localProductionTls.status, 1); assert.match(localProductionTls.stderr, /MQ_PROXY_CONFIGURATION_REJECTED/);
    fixture("admin-init", "maintenance", { MAINTENANCE_DATABASE_URL_FILE: "/run/secrets/maintenance_database_url", MQ_LAB_ACCOUNTS_FILE: "/run/secrets/accounts" });
    if (privatePreview) {
      stage = "actual private HTTPS plan";
      const opened = planProductionPrivatePreview({ currentRelease: release, config: manifest, receipt, preview });
      await apply(opened);
      const binding = json(docker(["inspect", service("proxy"), "--format", "{{json .HostConfig.PortBindings}}"]));
      assert.deepEqual(binding, { "443/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] });
      for (const name of ["app", "postgres"]) assert.deepEqual(json(docker(["inspect", service(name), "--format", "{{json .HostConfig.PortBindings}}"])), {});
      const previewEnvironment = json(docker(["inspect", service("app"), "--format", "{{json .Config.Env}}"]));
      assert.ok(previewEnvironment.includes("MQ_AUTH_ENABLED=true"));
      for (const name of ["MEDIA", "PUBLISH", "COMMENTS"]) assert.ok(previewEnvironment.includes(`MQ_${name}_ENABLED=false`));
      for (const [field, filename] of [["certificate", "preview_certificate"], ["privateKey", "preview_private_key"]]) {
        const digest = docker(["exec", service("proxy"), "sha256sum", `/run/secrets/${filename}`]).stdout.trim().split(/\s+/)[0];
        assert.equal(digest, preview[field].sha256);
      }
      assert.throws(() => planProductionActivation({ currentRelease: release, config: manifest, receipt, features: enabled }), /PRODUCTION_PREVIEW_MUST_CLOSE/);
      pass("private preview uses production Origin and host-loopback-only publication; activate remains separate");
      stage = "private preview auth and browser acceptance";
      const previewResult = await runPrivatePreviewChecks({ docker, project, directory, evidence, origin, port,
        ca: previewCa, wrongCa: previewWrongCa, accounts, secrets, toolsImage: images.tools, browserImage: previewBrowserImage,
        unusedPort, onStage: value => { stage = `private preview/${value}`; },
        directRequest: async () => json(fixture("direct-request")).status,
        revoke: async () => fixture("admin-revoke", "maintenance", { MAINTENANCE_DATABASE_URL_FILE: "/run/secrets/maintenance_database_url" }),
        restore: async () => fixture("admin-restore", "maintenance", { MAINTENANCE_DATABASE_URL_FILE: "/run/secrets/maintenance_database_url" }) });
      await apply(planProductionPreviewClose({ currentRelease: release, config: manifest, receipt }));
      assert.equal(service("proxy"), "");
      assert.equal(json(fixture("preview-session-count", "bootstrap", { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url" })).sessions, 0);
      const closedEnvironment = json(docker(["inspect", service("app"), "--format", "{{json .Config.Env}}"]));
      for (const name of ["AUTH", "MEDIA", "PUBLISH", "COMMENTS"]) assert.ok(closedEnvironment.includes(`MQ_${name}_ENABLED=false`));
      // Reopen through a *new* independent test approval to prove that old
      // Cookies are genuinely revoked, not merely hidden by disabled auth.
      await apply(planProductionPrivatePreview({ currentRelease: release, config: manifest, receipt, preview }));
      await previewResult.verifyRevoked();
      await apply(planProductionPreviewClose({ currentRelease: release, config: manifest, receipt }));
      assert.equal(json(fixture("preview-session-count", "bootstrap", { BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url" })).sessions, 0);
      pass("close revokes every acceptance session; later preview cannot revive old Cookies; all flags false");
      const logs = compose(["logs", "--no-color", "app", "proxy", "postgres"]).stdout;
      assert.ok([...secrets].every(value => !logs.includes(value)));
      await writeFile(join(evidence, "result.json"), JSON.stringify({ environment: "random local production-contract cluster",
        origin, checks, authenticationChecks: previewResult.checks, browserTlsVerification: true,
        binding, productionDeployed: false, publicPortsOpened: false, finalSessions: 0, peerVerification: previewResult.peerVerification,
        candidateApproval: "test fixture only", executor: "fixed-step laboratory adapter; production host executor not executed",
        peerScope: "separate Docker bridge container to Docker host gateway; not a real LAN or VPS external scan" }, null, 2));
      stage = "private preview/peer isolation final gate";
      assert.equal(previewResult.peerVerification.verified, true, "PRIVATE_PREVIEW_PEER_ISOLATION_FAILED");
      succeeded = true; return;
    }
    stage = "synthetic business startup and loopback TLS";
    await writeEnvironment(enabled); compose(["up", "-d", "--wait", "--wait-timeout", "180", "app"]);
    transport(["up", "-d", "--wait", "--wait-timeout", "180", "proxy"]);
    let ca;
    for (let attempt = 0; attempt < 60; attempt++) {
      const probe = docker(["exec", service("proxy"), "cat", "/data/caddy/pki/authorities/local/root.crt"], { fail: false });
      if (probe.status === 0 && probe.stdout.includes("BEGIN CERTIFICATE")) { ca = probe.stdout; break; }
      await delay(500);
    }
    assert.ok(ca);
    const request = laboratoryTransport(origin, ca, secrets);
    stage = "production HTTP/HTTPS and browser checks";
    const results = await runProductionHttpChecks({ origin, ca, admin: accounts.admin, reader: accounts.reader, secrets, evidenceDirectory: evidence,
      restart: async () => { compose(["stop", "app"]); compose(["up", "-d", "--force-recreate", "--wait", "postgres"]); compose(["up", "-d", "--wait", "--wait-timeout", "180", "app"]); },
      directRequest: async () => json(fixture("direct-request")).status,
      revoke: async () => { fixture("admin-revoke", "maintenance", { MAINTENANCE_DATABASE_URL_FILE: "/run/secrets/maintenance_database_url" }); } });
    pass("real production runtime HTTP/HTTPS business, browser, persistence and session revocation");
    fixture("admin-restore", "maintenance", { MAINTENANCE_DATABASE_URL_FILE: "/run/secrets/maintenance_database_url" });
    const oldJar = {};
    assert.equal((await request("/api/auth/sign-in/username", { method: "POST", body: accounts.admin, jar: oldJar })).status, 200);
    const publicImage = await request(`/api/stories/${results.storyId}/media/${results.assetId}`);
    assert.equal(publicImage.status, 200);
    const privateUpload = await request("/api/admin/media", { method: "POST", jar: oldJar, bytes: publicImage.bytes,
      headers: { "content-type": "image/webp", "idempotency-key": randomUUID() } });
    assert.equal(privateUpload.status, 201);
    const privateDraft = await request("/api/admin/stories", { method: "POST", jar: oldJar, body: { kind: "STAR", title: "仅用于恢复隔离的合成草稿",
      content: { version: 2, blocks: [{ type: "image", assetId: privateUpload.data.asset.id, alt: "未公开合成图片" }] } } });
    assert.equal(privateDraft.status, 201);
    compose(["stop", "proxy", "app"]);
    const backupArgs = ["run", "--rm", "--read-only", "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--network", `${project}_database`, "--mount", `type=volume,source=${volumes.manifest},target=/etc/mq,readonly`,
      "--mount", `type=volume,source=${volumes.backup},target=/run/secrets,readonly`, "--mount", `type=volume,source=${project}_media,target=/var/lib/mq/media`,
      "--mount", `type=volume,source=${volumes.operations},target=/var/lib/mq/operations`, "--tmpfs", "/tmp:rw,nosuid,size=64m,uid=10001,gid=10001,mode=0700"];
    for (const [key, value] of Object.entries({ MQ_SYNTHETIC_LAB: "true", MQ_SYNTHETIC_DEPLOYMENT_ID: id, MQ_DEPLOYMENT_CONFIG: "/etc/mq/deployment.json",
      BOOTSTRAP_DATABASE_URL_FILE: "/run/secrets/bootstrap_database_url", BACKUP_DATABASE_URL_FILE: "/run/secrets/backup_database_url", RESTIC_PASSWORD_FILE: "/run/secrets/restic_password", MQ_LAB_REVISION: sourceSha })) backupArgs.push("-e", `${key}=${value}`);
    stage = "real production-contract Restic backup";
    const backupReceipt = json(docker([...backupArgs, images.operations, "tests/fixtures/production-bootstrap-actions.mjs", "backup"]));
    assert.equal(backupReceipt.verified, true);
    pass("real encrypted PostgreSQL/media backup and verified update receipt");
    stage = "restore into another production-contract PostgreSQL cluster";
    await runProductionRecovery({ docker, compose, project, manifest, directory, evidence, images, volume, volumes, secret, files,
      envFile, overrideFile, transportFile, root, secrets }, { backupReceipt, ...results, oldJar, admin: accounts.admin,
      privateStoryId: privateDraft.data.story.id, privateAssetId: privateUpload.data.asset.id, imageHash: sha256(publicImage.bytes) });
    pass("different cluster same production DB name restored with old sessions/keys denied and HTTPS media/browser verified");
    for (const mode of ["upgrade", "rollback"]) {
      await apply(planProductionChange({ release, currentRelease: release, config: manifest, backupReceipt, mode,
        candidateManifestSha256: digest, features: enabled }));
      assert.equal(service("proxy"), "");
      transport(["up", "-d", "--wait", "--wait-timeout", "180", "proxy"]);
      assert.equal((await request(`/api/stories/${results.storyId}`)).status, 200);
      compose(["stop", "proxy"]);
    }
    pass("same-image upgrade/rollback steps preserve data and leave ingress closed");
    const failurePlan = planProductionChange({ release, currentRelease: release, config: manifest, backupReceipt, mode: "upgrade", candidateManifestSha256: digest, features: enabled });
    const lastSuccessfulReceipt = await readFile(join(evidence, "upgrade-receipt.json"), "utf8");
    await assert.rejects(apply(failurePlan, async (step, plan) => step === "health" ? false : execute(step, plan)), /PRODUCTION_FAILED_INGRESS_CLOSED/);
    assert.equal(await readFile(join(evidence, "upgrade-receipt.json"), "utf8"), lastSuccessfulReceipt);
    assert.equal(service("app"), ""); assert.equal(service("proxy"), "");
    pass("failed health does not issue success receipt and stops app/ingress");
    stage = "startup and capacity denials";
    for (const value of ["MQ_DEPLOYMENT_ENV=staging", "AUTH_SECRET=inline-forbidden"]) {
      const failure = compose(["run", "--rm", "--no-deps", "-e", value, "app"], { fail: false, timeout: 30000 });
      assert.equal(failure.status, 1); assert.match(failure.stderr, /MQ_STARTUP_REJECTED/);
    }
    const diskArgs = ["run", "--rm", "--read-only", "--network", `${project}_database`, "--mount", `type=volume,source=${volumes.manifest},target=/etc/mq,readonly`,
      "--mount", `type=volume,source=${volumes.app},target=/run/secrets,readonly`, "--tmpfs", "/var/lib/mq/media:rw,nosuid,size=8m,uid=10001,gid=10001,mode=0700"];
    for (const [key, value] of Object.entries({ NODE_ENV: "production", MQ_DEPLOYMENT_ENV: "production", MQ_SYNTHETIC_LAB: "true", MQ_SYNTHETIC_DEPLOYMENT_ID: id,
      MQ_DEPLOYMENT_CONFIG: "/etc/mq/deployment.json", DATABASE_URL_FILE: "/run/secrets/database_url", AUTH_SECRET_FILE: "/run/secrets/auth_secret", SESSION_STORAGE_KEY_FILE: "/run/secrets/session_storage_key", AUTH_PROXY_SECRET_FILE: "/run/secrets/auth_proxy_secret",
      MQ_PUBLISH_SIGNING_KEY_FILE: "/run/secrets/publish_signing_key", MQ_COMMENT_SIGNING_KEY_FILE: "/run/secrets/comment_signing_key" })) diskArgs.push("-e", `${key}=${value}`);
    docker([...diskArgs, images.tools, "tests/fixtures/production-bootstrap-actions.mjs", "disk-refusal"]);
    pass("wrong environment/inline secret denied and real tmpfs enforces 8 GiB reserve");
    const logs = compose(["logs", "--no-color", "app", "proxy", "postgres"]).stdout;
    assert.ok([...secrets].every(value => !logs.includes(value)));
    assert.ok(!logs.includes("@accounts.invalid"));
    await writeFile(join(evidence, "result.json"), JSON.stringify({ environment: "production contract in random local Docker cluster", checks,
      businessChecks: results.checks, productionDeployed: false, publicCertificateVerified: false, candidateApproval: "test fixture only",
      rollback: "same image; fixed executor steps and data persistence", publicPortsOpened: false }, null, 2));
    succeeded = true;
  } finally {
    if (configured) compose(["down", "--remove-orphans"], { fail: false });
    for (const helper of helpers) docker(["rm", "-f", helper], { fail: false });
    if (privatePreview) docker(["image", "rm", previewBrowserImage], { fail: false });
    if (succeeded) for (const name of docker(["volume", "ls", "--filter", `name=${project}`, "--format", "{{.Name}}"] ).stdout.trim().split(/\r?\n/).filter(Boolean)) {
      assert.ok(name.startsWith(`${project}_`)); docker(["volume", "rm", name]);
    }
  }
}

try { await main(); }
catch (error) {
  const detail = /^STAGING_HTTP_FAILED:[a-z /,-]+$/.test(error.message) ? ` (${error.message})` : "";
  console.error(`PRODUCTION_BOOTSTRAP_LAB_FAILED at ${stage}${detail}; scoped volumes retained, private output withheld`);
  process.exitCode = 1;
}
