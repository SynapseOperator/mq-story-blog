#!/bin/sh
# Run through SSH stdin. No installation, remote files, configuration changes,
# environment dump, account listing or raw command diagnostics.
set -u
set -f
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH LC_ALL=C LANG=C
privileged=no
case "$#:$*" in 0:) ;; 1:--sudo-read) privileged=yes ;; *) printf '%s\n' NATIVE_PREFLIGHT_ARGUMENT_REJECTED >&2; exit 1 ;; esac
command -v timeout >/dev/null 2>&1 || { printf '%s\n' NATIVE_PREFLIGHT_TIMEOUT_REQUIRED >&2; exit 1; }
run() { timeout 6 "$@" 2>/dev/null; }
priv() { if [ "$privileged" = yes ]; then run sudo -n -- "$@"; else run "$@"; fi; }
emit() { printf '%s\t%s\n' "$1" "$2"; }
number() { case "$2" in ''|*[!0-9.]*|.*|*.) emit "$1" unknown ;; *) emit "$1" "$2" ;; esac; }
word() { case "$2" in ''|*[!A-Za-z0-9_./+-]*) emit "$1" unknown ;; *) emit "$1" "$2" ;; esac; }
boolean() { case "$2" in yes|true|Y) emit "$1" true ;; no|false|N) emit "$1" false ;; *) emit "$1" unknown ;; esac; }
state() { case "$2" in active|inactive|failed|activating|deactivating|enabled|disabled|static|masked|indirect|generated|enabled-runtime) emit "$1" "$2" ;; *) emit "$1" unknown ;; esac; }
emit version 1
emit checkedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
emit privilegedRequested "$privileged"
word platform "$(run uname -s | tr '[:upper:]' '[:lower:]')"
word osId "$(awk -F= '$1=="ID" {gsub(/\"/,"",$2);print $2}' /etc/os-release 2>/dev/null)"
word osVersion "$(awk -F= '$1=="VERSION_ID" {gsub(/\"/,"",$2);print $2}' /etc/os-release 2>/dev/null)"
word architecture "$(run uname -m)"
number cpuCount "$(run getconf _NPROCESSORS_ONLN)"
for pair in 'MemTotal: totalMemoryBytes' 'MemAvailable: freeMemoryBytes' 'SwapTotal: swapTotalBytes' 'SwapFree: swapFreeBytes'; do
  set -- $pair
  number "$2" "$(awk -v key="$1" '$1==key {printf "%.0f\n",$2*1024}' /proc/meminfo 2>/dev/null)"
done
number load1 "$(awk '{print $1}' /proc/loadavg 2>/dev/null)"
number load5 "$(awk '{print $2}' /proc/loadavg 2>/dev/null)"
number load15 "$(awk '{print $3}' /proc/loadavg 2>/dev/null)"
disk=$(run df -P -B1 /) || disk=
number diskBytes "$(printf '%s\n' "$disk" | awk 'NR==2 {print $2}')"
number freeDiskBytes "$(printf '%s\n' "$disk" | awk 'NR==2 {print $4}')"
inodes=$(run df -Pi /) || inodes=
number inodeCount "$(printf '%s\n' "$inodes" | awk 'NR==2 {print $2}')"
number freeInodeCount "$(printf '%s\n' "$inodes" | awk 'NR==2 {print $4}')"
word timezone "$(run timedatectl show --property=Timezone --value)"
boolean timeSynchronized "$(run timedatectl show --property=NTPSynchronized --value)"
boolean apparmorEnabled "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)"
state apparmorService "$(run systemctl is-active apparmor)"
state sshService "$(run systemctl is-active ssh.service)"
state sshSocket "$(run systemctl is-active ssh.socket)"
state sshSocketEnabled "$(run systemctl is-enabled ssh.socket)"
ufw=$(priv ufw status) || ufw=
case "$ufw" in 'Status: active'*) boolean ufwActive yes ;; 'Status: inactive'*) boolean ufwActive no ;; *) boolean ufwActive unknown ;; esac

# Only the selected four values leave the process. sshd may need root to inspect
# its configuration/keys; permission failure stays unknown and never prompts.
sshd_settings() {
  settings=$1; prefix=$2
  root=$(printf '%s\n' "$settings" | awk '$1=="permitrootlogin" {print $2}')
  case "$root" in yes|no|prohibit-password|forced-commands-only) emit "$prefix.permitRootLogin" "$root" ;; *) emit "$prefix.permitRootLogin" unknown ;; esac
  boolean "$prefix.passwordAuthentication" "$(printf '%s\n' "$settings" | awk '$1=="passwordauthentication" {print $2}')"
  boolean "$prefix.keyboardInteractiveAuthentication" "$(printf '%s\n' "$settings" | awk '$1=="kbdinteractiveauthentication" {print $2}')"
  boolean "$prefix.publicKeyAuthentication" "$(printf '%s\n' "$settings" | awk '$1=="pubkeyauthentication" {print $2}')"
}
defaults=$(priv /usr/sbin/sshd -T) || defaults=
sshd_settings "$defaults" ssh.default
connection=; root_connection=; context=no
# The current transport addresses are used only to evaluate Match. They are
# never printed, persisted, resolved via DNS, or included in the report.
set -- ${SSH_CONNECTION-}
if [ "$#" -eq 4 ]; then
  client=$1; server=$3; port=$4
  account=$(run id -un) || account=
  case "$client:$server" in *[!0-9A-Fa-f:.]*|'') account= ;; esac
  case "$port" in ''|*[!0-9]*) account= ;; esac
  case "$account" in ''|*[!A-Za-z0-9_-]*) account= ;; esac
  if [ -n "$account" ]; then
    context=yes
    # With UseDNS=no OpenSSH uses the numeric peer address for Match Host.
    # Otherwise Host matching cannot be proven without reverse-DNS evidence.
    use_dns=$(printf '%s\n' "$defaults" | awk '$1=="usedns" {print $2}')
    host_option=
    if [ "$use_dns" = no ]; then host_option=",host=$client"; fi
    connection=$(priv /usr/sbin/sshd -T -C "user=$account,addr=$client,laddr=$server,lport=$port$host_option") || connection=
    root_connection=$(priv /usr/sbin/sshd -T -C "user=root,addr=$client,laddr=$server,lport=$port$host_option") || root_connection=
  fi
fi
boolean sshConnectionContext "$context"
if [ "$context" = yes ] && [ "${use_dns-unknown}" = no ]; then
  boolean sshHostMatchVerified yes
else boolean sshHostMatchVerified unknown; fi
sshd_settings "$connection" ssh.connection
sshd_settings "$root_connection" ssh.root
word dockerVersion "$(priv docker --host unix:///var/run/docker.sock version --format '{{.Server.Version}}')"
word composeVersion "$(run docker --host unix:///var/run/docker.sock compose version --short)"
node_version=$(run node --version) || node_version=
case "$node_version" in v[0-9]*.*) number nodeMajor "$(printf '%s' "${node_version#v}" | cut -d. -f1)" ;; *) number nodeMajor unknown ;; esac

if addresses=$(run ip -o address show) && [ -n "$addresses" ]; then
  presence=$(printf '%s\n' "$addresses" | awk '
    NF {if (NF<4 || ($3!="inet" && $3!="inet6")) exit 1; if ($2!="lo") {if ($3=="inet") v4=1; if ($3=="inet6") v6=1; if ($3=="inet6" && /scope global/) global6=1}}
    END {printf "%d %d %d",v4,v6,global6}')
  if [ "$?" -eq 0 ]; then
    set -- $presence
    [ "$1" = 1 ] && boolean ipv4Configured yes || boolean ipv4Configured no
    [ "$2" = 1 ] && boolean ipv6Configured yes || boolean ipv6Configured no
    [ "$3" = 1 ] && boolean ipv6GlobalConfigured yes || boolean ipv6GlobalConfigured no
  else boolean ipv4Configured unknown; boolean ipv6Configured unknown; boolean ipv6GlobalConfigured unknown; fi
else boolean ipv4Configured unknown; boolean ipv6Configured unknown; boolean ipv6GlobalConfigured unknown; fi

if sockets=$(run ss -H -lntu) && [ -n "$sockets" ]; then
  listeners=$(printf '%s\n' "$sockets" | awk '
    NF {if (++count>512 || ($1!="tcp" && $1!="udp") || NF<6) exit 1;
      endpoint=$5; port=endpoint; sub(/^.*:/,"",port);
      if (port!~/^[0-9]+$/ || port<1 || port>65535) exit 1;
      sub(/:[^:]*$/,"",endpoint); gsub(/^\[|\]$/,"",endpoint); sub(/%.*/,"",endpoint);
      localOnly=(endpoint=="::1" || endpoint~/^(::ffff:)?127\.[0-9]+\.[0-9]+\.[0-9]+$/);
      printf "%s,%d,%s\n",$1,port,localOnly?"loopback":"non-loopback"}')
  if [ "$?" -eq 0 ]; then
    boolean listenersKnown yes
    printf '%s\n' "$listeners" | sort -u | while IFS= read -r item; do [ -z "$item" ] || emit listener "$item"; done
  else boolean listenersKnown unknown; fi
else boolean listenersKnown unknown; fi
