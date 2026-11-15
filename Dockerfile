# syntax=docker/dockerfile:1
FROM oven/bun:1.4.4 AS bun
FROM node:22-bookworm-slim AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build \
 && bun build src/lib/db/migrate.ts --target=node --format=esm --external @libsql/client --outfile .next/standalone/migrate.mjs \
 && bun build docker/prepare.ts --target=node --format=esm --outfile .next/standalone/prepare.mjs

# Runs on Bun: Discord's gateways refuse WebSocket connections from Node
# (src/lib/discord/bun-websocket.ts).
FROM oven/bun:1.4.4-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/data/discord-mcp.db \
    DISCORD_MCP_MIGRATIONS_DIR=/app/drizzle \
    PUID=1000 PGID=1000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/drizzle ./drizzle
COPY docker/entrypoint.sh docker/start.sh ./docker/
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/sign-in').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/app/docker/entrypoint.sh"]
