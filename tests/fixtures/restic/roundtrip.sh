#!/bin/sh
set -eu
umask 077
restic_binary=${1:?Pass the built Restic binary}
lab=$(mktemp -d /tmp/mq-restic-rebuild.XXXXXXXX)
mkdir "$lab/source" "$lab/cache" "$lab/restored"
head -c 32 /dev/urandom | base64 > "$lab/password"
head -c 32 /dev/urandom | base64 > "$lab/wrong-password"
export RESTIC_REPOSITORY="$lab/repository" RESTIC_PASSWORD_FILE="$lab/password" RESTIC_CACHE_DIR="$lab/cache"
printf 'MQ synthetic story; no personal content\n' > "$lab/source/story.txt"
printf '\211PNG\r\n\032\nMQ synthetic bytes\n' > "$lab/source/image.bin"
"$restic_binary" init --repository-version 2 > "$lab/init.log" 2>&1
"$restic_binary" backup --quiet "$lab/source" > "$lab/backup.log" 2>&1
snapshot=$("$restic_binary" list snapshots)
test "${#snapshot}" = 64
case "$snapshot" in *[!a-f0-9]*) exit 1;; esac
"$restic_binary" snapshots --json > "$lab/snapshots.json"
"$restic_binary" check --read-data > "$lab/check.log" 2>&1
"$restic_binary" restore "$snapshot" --target "$lab/restored" > "$lab/restore.log" 2>&1
restored_story=$(find "$lab/restored" -type f -name story.txt)
restored_image=$(find "$lab/restored" -type f -name image.bin)
test -n "$restored_story" && test -n "$restored_image"
cmp "$lab/source/story.txt" "$restored_story"
cmp "$lab/source/image.bin" "$restored_image"
if RESTIC_PASSWORD_FILE="$lab/wrong-password" "$restic_binary" snapshots > "$lab/denied.log" 2>&1; then
    echo 'FAIL: incorrect repository password accepted'
    exit 1
fi
"$restic_binary" check --read-data > "$lab/check-after-denial.log" 2>&1
echo 'PASS: local encrypted init/backup/list/full-check/exact-restore; incorrect password rejected; repository preserved'
# Only this short-lived container's private /tmp was used. The container runner
# removes its own namespace; this test performs no host/OSS deletion.
