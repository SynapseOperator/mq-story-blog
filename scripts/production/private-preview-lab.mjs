import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { laboratoryTransport } from "./http-tests.mjs";

export async function runPrivatePreviewChecks({ docker, project, directory, evidence, root, origin, port, ca, wrongCa,
  accounts, secrets, toolsImage, browserImage, directRequest, revoke, restore, unusedPort, onStage }) {
  assert.equal(origin, "https://mq-story.xyz");
  const request = laboratoryTransport(origin, ca, secrets, { connectPort: port });
  const checks = [], jars = [];
  const check = async (name, action) => { onStage(name); await action(); checks.push(name); console.log(`PASS private preview: ${name}`); };
  const expect = (value, status) => { assert.equal(value.status, status); return value; };
  const login = async account => {
    const jar = {}; jars.push(jar);
    const response = expect(await request("/api/auth/sign-in/username", { method: "POST", body: account, jar }), 200);
    const cookie = response.cookieLines.find(line => /^__Secure-mq\.session_token=/.test(line));
    assert.ok(cookie && /; Secure/i.test(cookie) && /; HttpOnly/i.test(cookie) && /; SameSite=Lax/i.test(cookie));
    assert.ok(!/; Domain=/i.test(cookie)); return jar;
  };
  await check("exact production Origin, valid private CA and wrong CA refusal", async () => {
    expect(await request("/"), 200);
    await assert.rejects(laboratoryTransport(origin, wrongCa, secrets, { connectPort: port })("/"),
      error => ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"].includes(error.code));
  });
  let reader, admin;
  await check("ordinary/admin login, Cookie attributes, 401/403 and production auth whitelist", async () => {
    expect(await request("/api/admin/stories"), 401);
    expect(await request("/api/auth/sign-up/email", { method: "POST", body: accounts.reader }), 200);
    reader = await login(accounts.reader); admin = await login(accounts.admin);
    expect(await request("/api/admin/stories", { jar: reader }), 403);
    expect(await request("/api/admin/stories", { jar: admin }), 200);
    for (const path of ["list-sessions", "revoke-session", "revoke-other-sessions", "revoke-sessions"]) {
      const response = await request(`/api/auth/${path}`, { method: path === "list-sessions" ? "GET" : "POST", jar: admin, body: path === "list-sessions" ? undefined : {} });
      expect(response, 404);
    }
    for (const jar of [reader, admin]) assert.ok(expect(await request("/api/auth/get-session", { jar }), 200).data.user);
  });
  await check("Origin/CSRF and forged proxy headers fail closed", async () => {
    expect(await request("/api/auth/sign-in/username", { method: "POST", body: accounts.admin, requestOrigin: "https://outside.invalid" }), 403);
    expect(await request("/api/auth/sign-out", { method: "POST", jar: admin, body: {}, requestOrigin: null }), 403);
    expect(await request("/api/admin/stories", { jar: admin, requestOrigin: "https://outside.invalid" }), 403);
    expect(await request("/api/admin/stories", { jar: admin, headers: { "x-mq-proxy-key": "forged", "x-mq-client-ip": "invalid" } }), 200);
    assert.equal(await directRequest(), 403);
  });
  await check("sign-out and administrator revocation invalidate actual sessions", async () => {
    const signedOut = await login(accounts.reader);
    const old = { cookie: signedOut.cookie };
    expect(await request("/api/auth/sign-out", { method: "POST", jar: signedOut, body: {} }), 200);
    assert.equal(expect(await request("/api/auth/get-session", { jar: old }), 200).data, null);
    await revoke(); expect(await request("/api/admin/stories", { jar: admin }), 401);
    await restore(); admin = await login(accounts.admin);
  });

  // The browser container trusts only this test CA via its private NSS store.
  // A random, strictly checked SSH reverse tunnel routes browser loopback:443
  // to the *host-published* loopback port. No host CA import/TLS bypass/DNS edit.
  const container = `${project}-private-browser`, sshPort = await unusedPort();
  onStage("prepare private trusted browser and isolated SSH transport");
  const key = join(directory, "browser-tunnel"), knownHosts = join(directory, "browser-known-hosts");
  const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { encoding: "utf8", windowsHide: true });
  assert.equal(generated.status, 0, "PRIVATE_BROWSER_TEST_KEY_FAILED");
  await writeFile(join(directory, "preview-ca.pem"), ca);
  await writeFile(join(directory, "browser-input.json"), JSON.stringify({ origin, admin: accounts.admin }), { mode: 0o600 });
  let tunnel;
  try {
    onStage("private browser image and container startup");
    docker(["image", "inspect", browserImage]);
    docker(["run", "-d", "--name", container, "--label", `mq.lab=${project}`, "--network", "bridge",
      "--publish", `127.0.0.1:${sshPort}:22`, "--memory", "1g", "--cpus", "1", "--pids-limit", "256", "--shm-size", "256m",
      "--mount", `type=bind,source=${join(root, "node_modules")},target=/app/node_modules,readonly`, browserImage]);
    for (const [source, target] of [[`${key}.pub`, "authorized_keys"], [join(directory, "preview-ca.pem"), "ca.pem"], [join(directory, "browser-input.json"), "input.json"]])
      docker(["cp", source, `${container}:/fixture/${target}`]);
    onStage("private browser NSS trust and sshd setup");
    docker(["exec", container, "sh", "-eu", "-c", `
      chmod 0700 /fixture
      chmod 0600 /fixture/authorized_keys /fixture/input.json
      mkdir -p /root/.pki/nssdb
      certutil -N -d sql:/root/.pki/nssdb --empty-password
      certutil -A -d sql:/root/.pki/nssdb -n mq-private-lab -t 'C,,' -i /fixture/ca.pem
      ssh-keygen -q -t ed25519 -N '' -f /fixture/host_key
      printf '%s\\n' 'Port 22' 'HostKey /fixture/host_key' 'AuthorizedKeysFile /fixture/authorized_keys' 'PermitRootLogin prohibit-password' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'UsePAM no' 'AllowTcpForwarding remote' 'PermitListen 127.0.0.1:443' 'GatewayPorts no' 'PermitTunnel no' 'LogLevel ERROR' > /fixture/sshd_config
      usermod --password '*' root
      /usr/sbin/sshd -f /fixture/sshd_config
    `]);
    const publicHostKey = docker(["exec", container, "cat", "/fixture/host_key.pub"]).stdout.trim();
    assert.match(publicHostKey, /^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/);
    await writeFile(knownHosts, `[127.0.0.1]:${sshPort} ${publicHostKey}\n`);
    onStage("private browser reverse tunnel establishment");
    tunnel = spawn("ssh", ["-N", "-T", "-i", key, "-p", String(sshPort), "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "ExitOnForwardFailure=yes",
      "-R", `127.0.0.1:443:127.0.0.1:${port}`, "root@127.0.0.1"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let tunnelError = "unknown";
    tunnel.stderr.on("data", chunk => {
      const text = chunk.toString();
      for (const [pattern, code] of [[/Permission denied/i, "public-key-rejected"], [/Host key verification failed/i, "host-key-rejected"],
        [/remote port forwarding failed/i, "remote-forward-rejected"], [/Connection refused/i, "sshd-unreachable"], [/bad permissions/i, "test-key-acl-rejected"]])
        if (pattern.test(text)) tunnelError = code;
    });
    let ready = false;
    for (let i = 0; i < 40; i++) {
      if (tunnel.exitCode !== null) {
        onStage(`private browser tunnel failed: ${tunnelError}`);
        throw new Error("PRIVATE_BROWSER_TUNNEL_FAILED");
      }
      const probe = docker(["exec", container, "node", "--input-type=module", "--eval",
        "import net from 'node:net';const s=net.connect(443,'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(500,()=>process.exit(1));"], { fail: false });
      if (probe.status === 0) { ready = true; break; } await delay(250);
    }
    assert.ok(ready);
    await check("desktop/mobile browser trusts isolated CA with exact production Origin", async () => {
      const result = docker(["exec", container, "node", "/fixture/private-preview-browser.mjs"], { timeout: 180000, fail: false });
      if (result.status !== 0) {
        const status = JSON.parse(docker(["exec", container, "cat", "/fixture/result.json"]).stdout);
        assert.match(status.stage, /^[a-z-]+$/); onStage(`private browser failed: ${status.stage}`);
        throw new Error("PRIVATE_PREVIEW_BROWSER_FAILED");
      }
      for (const name of ["desktop", "mobile"]) docker(["cp", `${container}:/fixture/private-preview-${name}.png`, join(evidence, `private-preview-${name}.png`)]);
      const browserResult = JSON.parse(docker(["exec", container, "cat", "/fixture/result.json"]).stdout);
      assert.equal(browserResult.ignoreHTTPSErrors, false);
      await writeFile(join(evidence, "private-preview-browser.json"), JSON.stringify(browserResult, null, 2));
      for (const cookie of JSON.parse(docker(["exec", container, "cat", "/fixture/sessions.json"]).stdout)) {
        secrets.add(cookie); jars.push({ cookie });
      }
    });
  } finally {
    if (tunnel && tunnel.exitCode === null) tunnel.kill();
    docker(["rm", "-f", container], { fail: false });
  }
  onStage("another container to the host-published private port");
  const probe = docker(["run", "--rm", "--network", "bridge", "--add-host", "mq-preview-host:host-gateway", toolsImage,
    "--input-type=module", "--eval", `import net from 'node:net';const finish=(connected,code)=>{console.log(JSON.stringify({connected,code}));s.destroy();};const s=net.connect(${port},'mq-preview-host');s.once('connect',()=>finish(true,'CONNECTED'));s.once('error',e=>finish(false,e.code));s.setTimeout(2000,()=>finish(false,'ETIMEDOUT'));`]);
  const observed = JSON.parse(probe.stdout);
  assert.ok(observed.connected || ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].includes(observed.code));
  const daemon = JSON.parse(docker(["info", "--format", "{{json .OperatingSystem}}" ]).stdout);
  const peerVerification = { hostPlatform: process.platform, daemon, ...observed, verified: !observed.connected,
    scope: "separate bridge container to Docker host-gateway; Docker Desktop is not a native Linux firewall test" };
  // Keep the negative observation, but first close the private entrance and
  // prove session revocation. The caller still exits nonzero for this failure.
  if (peerVerification.verified) {
    checks.push("peer container denied at host-published port");
    console.log("PASS private preview: peer container denied at host-published port");
  } else console.error("FAIL private preview: peer reached host-published port; closing preview before reporting failure");
  return { checks, peerVerification, async verifyRevoked() {
    for (const jar of jars) assert.equal(expect(await request("/api/auth/get-session", { jar }), 200).data, null);
  } };
}
