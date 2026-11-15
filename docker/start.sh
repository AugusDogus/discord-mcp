#!/bin/sh
set -eu
umask 077
cd /app
node prepare.mjs
export BETTER_AUTH_URL="${DISCORD_MCP_URL%/}"
if [ -z "${KEY_PEPPER:-}" ]; then
  KEY_PEPPER="$(cat /data/secrets/key-pepper)"
fi
if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
  BETTER_AUTH_SECRET="$(cat /data/secrets/auth-secret)"
fi
export KEY_PEPPER BETTER_AUTH_SECRET
node migrate.mjs
export HOSTNAME=0.0.0.0 PORT=3000
exec node server.js
