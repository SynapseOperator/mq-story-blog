#!/bin/sh
set -eu
umask 077
upstream=${1:?Pass the official upstream Restic binary}
rebuilt=${2:?Pass the MQ rebuilt Restic binary}
lab=$(mktemp -d /tmp/mq-restic-compatibility.XXXXXXXX)
mkdir "$lab/source" "$lab/cache" "$lab/new-read" "$lab/old-read"
head -c 32 /dev/urandom | base64 > "$lab/password"
export RESTIC_REPOSITORY="$lab/repository" RESTIC_PASSWORD_FILE="$lab/password" RESTIC_CACHE_DIR="$lab/cache"
printf 'MQ synthetic old-writer story\n' > "$lab/source/story.txt"
printf '\211PNG\r\n\032\nMQ synthetic image bytes\n' > "$lab/source/image.bin"
"$upstream" init --repository-version 2 > "$lab/init.log" 2>&1
"$upstream" backup --quiet "$lab/source" > "$lab/old-backup.log" 2>&1
old_snapshot=$("$upstream" list snapshots)
test "${#old_snapshot}" = 64
case "$old_snapshot" in *[!a-f0-9]*) exit 1;; esac
"$rebuilt" check --read-data > "$lab/new-check.log" 2>&1
"$rebuilt" restore "$old_snapshot" --target "$lab/new-read" > "$lab/new-restore.log" 2>&1
cmp "$lab/source/story.txt" "$(find "$lab/new-read" -type f -name story.txt)"
cmp "$lab/source/image.bin" "$(find "$lab/new-read" -type f -name image.bin)"
"$rebuilt" cat config > "$lab/new-config.json"
grep -q '"version": 2' "$lab/new-config.json"
printf 'MQ synthetic new-writer story\n' > "$lab/source/story.txt"
"$rebuilt" backup --quiet "$lab/source" > "$lab/new-backup.log" 2>&1
new_snapshot=$("$rebuilt" list snapshots | grep -v "$old_snapshot")
test "${#new_snapshot}" = 64
case "$new_snapshot" in *[!a-f0-9]*) exit 1;; esac
"$upstream" check --read-data > "$lab/old-check.log" 2>&1
"$upstream" restore "$new_snapshot" --target "$lab/old-read" > "$lab/old-restore.log" 2>&1
cmp "$lab/source/story.txt" "$(find "$lab/old-read" -type f -name story.txt)"
cmp "$lab/source/image.bin" "$(find "$lab/old-read" -type f -name image.bin)"
"$upstream" cat config > "$lab/old-config.json"
cmp "$lab/new-config.json" "$lab/old-config.json"
echo 'PASS: official 0.19.1 writes -> MQ reads; MQ writes -> official reads; full checks and byte-exact restores; repository v2 unchanged'
