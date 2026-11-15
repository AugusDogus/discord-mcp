#!/bin/sh
set -eu
umask 077

PUID=${PUID:-1000}
PGID=${PGID:-1000}
for discord_id in "$PUID" "$PGID"; do
  case "$discord_id" in
    ''|*[!0-9]*) echo '[discord-mcp] PUID and PGID must be numeric IDs.' >&2; exit 1 ;;
  esac
done
if [ "$PUID" -eq 0 ]; then
  echo '[discord-mcp] Choose a non-root PUID to run the app.' >&2
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /data
  chown -R "$PUID:$PGID" /data
  chmod 700 /data
  exec gosu "$PUID:$PGID" /app/docker/start.sh
fi
exec /app/docker/start.sh
