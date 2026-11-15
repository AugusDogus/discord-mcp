# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4 AS bun
FROM node:22-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build:login-extension /app/login-extension \
 && bun run build \
 && bun build src/lib/db/migrate.ts --target=node --format=esm --external @libsql/client --outfile .next/standalone/migrate.mjs \
 && bun build docker/prepare.ts --target=node --format=esm --outfile .next/standalone/prepare.mjs

# Selkies supplies Wayland, the streamed desktop, nginx and s6. Keep Bun:
# Discord's interaction gateway refuses Node (src/lib/discord/bun-websocket.ts).
FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium \
 && apt-get autoclean \
 && rm -rf /var/lib/apt/lists/* /var/tmp/* /tmp/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

# Locked-down desktop, matching openrcs: paste into the browser only.
ENV TITLE=discord-mcp \
    PIXELFLUX_WAYLAND=true \
    SUBFOLDER=/login-browser/ \
    HARDEN_DESKTOP=true \
    START_DOCKER=false \
    NO_DECOR=true \
    NO_GAMEPAD=true \
    NO_WEBCAM=true \
    NO_STEAM=true \
    SELKIES_UI_SHOW_SIDEBAR=false \
    SELKIES_UI_SHOW_CORE_BUTTONS=false \
    SELKIES_KEYBOARD_SHORTCUTS=false \
    SELKIES_SECOND_SCREEN=false \
    SELKIES_AUDIO_ENABLED=false \
    SELKIES_MICROPHONE_ENABLED=false \
    SELKIES_WEBCAM_ENABLED=false \
    SELKIES_GAMEPAD_ENABLED=false \
    SELKIES_ENABLE_SHARING=false \
    SELKIES_FILE_TRANSFERS=none \
    SELKIES_PRINTING_ENABLED=false \
    SELKIES_COMMAND_ENABLED=false \
    SELKIES_ENABLE_CLIPBOARD=in \
    SELKIES_MANUAL_WIDTH=1024 \
    SELKIES_MANUAL_HEIGHT=768 \
    SELKIES_ENABLE_RESIZE=false \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/data/discord-mcp.db \
    DISCORD_MCP_MIGRATIONS_DIR=/app/drizzle \
    DISCORD_MCP_LOGIN_BROWSER_DIR=/dev/shm/discord-mcp-browser \
    PUID=1000 PGID=1000

WORKDIR /app
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/login-extension ./login-extension
COPY docker/root/ /
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/sign-in').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Keep the base image's /init entrypoint: s6 starts nginx, Selkies and Bun.
