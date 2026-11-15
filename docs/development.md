# Development

Requires Bun 1.4.4 and Node 22 for the container startup bundles.

```sh
bun install --frozen-lockfile
cp .env.example .env.local
# Fill BETTER_AUTH_SECRET and KEY_PEPPER with separate: openssl rand -base64 32
bun run db:migrate
bun run dev
```

The dashboard signs in using Tailscale Serve's user headers. Point Serve at the development server from a host on your tailnet, and set `BETTER_AUTH_URL` to that HTTPS origin before starting it. For the standard packaged installation, follow [Self-hosting](self-hosting.md). Never use a real Discord token in tests or make a live Discord call to verify a change.

## Checks

```sh
bun test
bun run typecheck
bun run lint
bun run build
docker build -t discord-mcp:verify .
```

Run the Docker check when a daemon is available. Tests use `bun:test`, fake REST fetches, a fake QR gateway, fake presence sessions and temporary SQLite databases with the real migrations. Clock injection covers presence expiry and active operations. HTTP MCP tests exercise tool discovery, schemas, annotations, scope challenges and confirmation guards. Logout tests cover remote failure, rejected tokens, cleanup and isolation between users. Startup tests verify secret persistence and permissions.

TypeScript is strict. Keep expected failures as `better-result` values, validate external responses with Zod, and avoid unsafe assertions. For Next.js API changes, read the installed guides under `node_modules/next/dist/docs/` first.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/lib/discord/remote-auth.ts` | QR login protocol |
| `src/lib/discord/login-session.ts` | Per-user login lifecycle |
| `src/lib/discord/account-store.ts` | Sealed token/profile and presence preference |
| `src/lib/discord/rest.ts` | Token-authenticated HTTP requests and rejection handling |
| `src/lib/discord/account-health.ts` | Cached `/users/@me` health |
| `src/lib/discord/gateway.ts` / `presence.ts` | On-demand gateway and idle expiry |
| `src/lib/discord/service.ts` | REST tool operations and ownership guards |
| `src/lib/discord/interactions.ts` / `slash-command.ts` | Interaction payloads and argument validation |
| `src/lib/discord/guild-layout.ts` | Versioned protobuf guild-folder updates |
| `src/lib/discord/account-lease.ts` / `logout.ts` | Per-user serialization and logout |
| `src/lib/mcp/` | HTTP MCP tool definitions and scope guards |
| `src/lib/oauth/` | OAuth authorization server |
| `src/app/dashboard/` | QR login, Account and Agents UI |
| `docker/`, `Dockerfile`, `unraid/` | Standalone packaging |

The tool definitions were ported from [discord-selfbot-mcp](https://github.com/AugusDogus/discord-selfbot-mcp). Its always-connected selfbot client and local-file upload code are omitted. `discord.js-selfbot-v13` is no longer a dependency. `discord-protos` encodes only guild-folder updates; gateway sessions use `ws` directly.

## Verification limits

The owner previously exercised QR login with their phone. This implementation pass uses fakes for Discord access, interactions and logout. It does not verify Discord's current private REST endpoints against a live account, its cross-session presence rules, or live OAuth setup in each example client. The Docker daemon was unavailable during implementation, so the image build and container startup remain unverified. The migration and startup bundles compile, and the migration bundle was run twice against a fresh temporary database to verify repeat startup.
