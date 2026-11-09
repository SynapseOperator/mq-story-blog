#!/bin/sh
set -eu
reject() { echo MQ_PROXY_CONFIGURATION_REJECTED >&2; exit 1; }
case "${MQ_DEPLOYMENT_ENV:-}" in staging|production) ;; *) reject ;; esac
case "${MQ_PUBLIC_HOST:-}" in ''|*[!a-z0-9.-]*|.*|*..*|-*|*-) reject ;; esac
[ "${#MQ_PUBLIC_HOST}" -le 253 ] || reject
[ -z "${MQ_PROXY_SECRET:-}" ] || reject
[ "${AUTH_PROXY_SECRET_FILE:-}" = /run/secrets/auth_proxy_secret ] || reject
[ -f "$AUTH_PROXY_SECRET_FILE" ] && [ ! -L "$AUTH_PROXY_SECRET_FILE" ] || reject
[ "$(stat -c %u "$AUTH_PROXY_SECRET_FILE")" = "$(id -u)" ] || reject
case "$(stat -c %a "$AUTH_PROXY_SECRET_FILE")" in 400|600) ;; *) reject ;; esac
MQ_PROXY_SECRET="$(cat "$AUTH_PROXY_SECRET_FILE")"
[ "${#MQ_PROXY_SECRET}" -eq 64 ] || reject
case "$MQ_PROXY_SECRET" in *[!a-f0-9]*) reject ;; esac
export MQ_PROXY_SECRET
case "${MQ_TLS_MODE:-public}" in
  public)
    case "$MQ_PUBLIC_HOST" in localhost|*.localhost|*.invalid) reject ;; esac
    MQ_CADDY_CONFIG=/etc/caddy/Caddyfile ;;
  local)
    [ "$MQ_DEPLOYMENT_ENV" = staging ] || reject
    case "$MQ_PUBLIC_HOST" in *.localhost) ;; *) reject ;; esac
    MQ_CADDY_CONFIG=/etc/caddy/Caddyfile.local ;;
  private)
    [ "$MQ_DEPLOYMENT_ENV" = production ] || reject
    case "$MQ_PUBLIC_HOST" in localhost|*.localhost|*.invalid) reject ;; esac
    for file in /run/secrets/preview_certificate /run/secrets/preview_private_key; do
      [ -f "$file" ] && [ ! -L "$file" ] || reject
      [ "$(stat -c %u "$file")" = "$(id -u)" ] || reject
      case "$(stat -c %a "$file")" in 400|600) ;; *) reject ;; esac
    done
    MQ_CADDY_CONFIG=/etc/caddy/Caddyfile.private ;;
  *) reject ;;
esac
exec caddy run --config "$MQ_CADDY_CONFIG" --adapter caddyfile
