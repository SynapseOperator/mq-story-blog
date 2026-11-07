import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// No host mounts, published ports, SSH connections or host configuration changes.
// The package comes from Ubuntu's signed repositories inside this disposable image.
const image = "ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852";
const container = `mq-ssh-config-test-${randomUUID()}`;
const script = String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod 755 /usr/sbin/policy-rc.d
if ! (apt-get update -qq && apt-get install -y --no-install-recommends openssh-server) >/tmp/package-install.log 2>&1; then
  echo BLOCKED_UBUNTU_OPENSSH_PACKAGE_INSTALL
  exit 2
fi
dpkg-query -W openssh-server
fixtures=$(mktemp -d /tmp/mq-ssh-fixtures.XXXXXX)
mkdir -p /run/sshd "$fixtures/conf.d"
ssh-keygen -q -t ed25519 -N '' -f "$fixtures/synthetic-host-key"

cat > "$fixtures/main.conf" <<EOF
Include $fixtures/conf.d/*.conf
HostKey $fixtures/synthetic-host-key
UsePAM yes
PasswordAuthentication no
EOF
printf 'PasswordAuthentication yes\n' > "$fixtures/conf.d/50-cloud-init.conf"
printf 'PasswordAuthentication no\n' > "$fixtures/conf.d/99-mq.conf"

check_setting() {
  # Synthetic documentation addresses only; no real client or server identity.
  /usr/sbin/sshd -T -f "$1" -C "user=$2,addr=192.0.2.10,host=fixture.invalid,laddr=192.0.2.20,lport=22" > "$fixtures/effective"
  if ! grep -Fqx "$3 $4" "$fixtures/effective"; then
    echo "FAIL effective setting: $2 $3"
    exit 1
  fi
}

/usr/sbin/sshd -t -f "$fixtures/main.conf"
check_setting "$fixtures/main.conf" mqops passwordauthentication yes
echo 'PASS early cloud-init value wins over 99 snippet and main config'

cat > "$fixtures/conf.d/00-mq.conf" <<'EOF'
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
/usr/sbin/sshd -t -f "$fixtures/main.conf"
for user in mqops root; do
  check_setting "$fixtures/main.conf" "$user" pubkeyauthentication yes
  check_setting "$fixtures/main.conf" "$user" authenticationmethods publickey
  check_setting "$fixtures/main.conf" "$user" passwordauthentication no
  check_setting "$fixtures/main.conf" "$user" kbdinteractiveauthentication no
  check_setting "$fixtures/main.conf" "$user" permitrootlogin no
done
echo 'PASS first snippet enforces all five target settings for mqops and root'

# A plain global -T check is insufficient: real connection Match rules apply.
cat "$fixtures/conf.d/00-mq.conf" > "$fixtures/match.conf"
cat >> "$fixtures/match.conf" <<EOF
HostKey $fixtures/synthetic-host-key
UsePAM yes
Match User mqops
    PasswordAuthentication yes
Match User root
    PermitRootLogin yes
EOF
/usr/sbin/sshd -t -f "$fixtures/match.conf"
/usr/sbin/sshd -T -f "$fixtures/match.conf" > "$fixtures/global"
grep -Fqx 'passwordauthentication no' "$fixtures/global"
grep -Fqx 'permitrootlogin no' "$fixtures/global"
check_setting "$fixtures/match.conf" mqops passwordauthentication yes
check_setting "$fixtures/match.conf" mqops permitrootlogin no
check_setting "$fixtures/match.conf" root passwordauthentication no
check_setting "$fixtures/match.conf" root permitrootlogin yes
echo 'PASS connection-aware Match checks detect overrides hidden by global checks'

cp "$fixtures/main.conf" "$fixtures/invalid.conf"
printf 'MQInvalidDirective yes\n' >> "$fixtures/invalid.conf"
if /usr/sbin/sshd -t -f "$fixtures/invalid.conf" > "$fixtures/invalid-output" 2>&1; then
  echo 'FAIL sshd accepted an invalid directive'
  exit 1
fi
grep -Fq 'MQInvalidDirective' "$fixtures/invalid-output"
echo 'PASS sshd -t rejects invalid configuration'
echo 'PASS synthetic OpenSSH configuration checks; no daemon or socket activation tested'
`;

try {
  const output = execFileSync("docker", ["run", "--rm", "-i", "--name", container,
    "--memory", "384m", "--cpus", "1", "--pids-limit", "128", image, "sh", "-s"], {
    input: script, encoding: "utf8", windowsHide: true, timeout: 600_000,
    stdio: ["pipe", "pipe", "pipe"], maxBuffer: 1024 * 1024,
  });
  process.stdout.write(output);
} catch (error) {
  // The child only emits fixed test results and package version, never keys/config.
  if (error.stdout) process.stdout.write(error.stdout);
  console.error("SSH_HARDENING_CONFIG_TEST_FAILED");
  process.exitCode = 1;
} finally {
  // Remove only this run's generated container if the CLI timed out or failed.
  try {
    execFileSync("docker", ["rm", "-f", container], {
      stdio: "ignore", windowsHide: true, timeout: 30_000,
    });
  } catch { /* --rm normally removed it already. */ }
}
