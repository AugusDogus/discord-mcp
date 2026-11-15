# Development

Requires Bun 1.4.4. The app runs on Bun, including `bun run dev` and the Docker image: Discord's WebSocket gateways refuse connections from Node, so interaction and presence gateways require Bun (see `src/lib/discord/bun-websocket.ts`).

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

Run the Docker check when a daemon is available. Tests use `bun:test`, fake REST fetches, a fake browser launcher and extension reports, fake presence sessions and temporary SQLite databases with the real migrations. Clock injection covers presence expiry and active operations. HTTP MCP tests exercise tool discovery, schemas, annotations, scope challenges and confirmation guards. Logout tests cover remote failure, rejected tokens, cleanup and isolation between users. Startup tests verify secret persistence and permissions.

TypeScript is strict. Keep expected failures as `better-result` values, validate external responses with Zod, and avoid unsafe assertions. For Next.js API changes, read the installed guides under `node_modules/next/dist/docs/` first.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/lib/login-browser/` | Exclusive browser lifecycle, validated reports, token verification and HTTP authorization |
| `docker/login-extension/` | MV3 content script, service worker, QR decoder and pure parsing helpers |
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

The tool definitions were ported from [discord-selfbot-mcp](https://github.com/AugusDogus/discord-selfbot-mcp). Its always-connected selfbot client and local-file upload code are omitted. `discord.js-selfbot-v13` is no longer a dependency. `discord-protos` encodes only guild-folder updates; gateway sessions use Bun's built-in WebSocket client.

## Browser login development

The browser login requires Linux Chromium, a Wayland desktop, Selkies and nginx. Use the container on a Docker-capable Linux host to exercise it. A local Mac `bun run dev` still supports the rest of the app, but does not provide this desktop or `/login-browser/` stream.

`bun run build:login-extension <output-directory>` bundles `content.ts` and `service-worker.ts` with `jsqr`, Zod and the shared report schema, and copies `manifest.json`. The image builds this into `/app/login-extension`. No secret is present in that bundle. Each launch copies it into the private RAM profile and writes a mode-0600 `config.json` containing the one-time secret. The extension has no externally connectable or web-accessible resources.

The isolated content script inspects Discord every second. It rasterizes visible SVG/image QR artwork (or copies canvas pixels), decodes it with `jsqr`, and sends only the validated URL. Confirmation detection requires a phone prompt, a name and a Discord CDN avatar. Visible captcha frames or containers take priority. If the server sees no known state for five seconds, it shows the live streamed browser, including when extension loading or selectors fail.

Token capture uses the content script's isolated-world `globalThis.localStorage.getItem("token")`, followed by JSON parsing. It runs after `/channels` is reached or the login page disappears. Discord deleting `window.localStorage` in the main world should not remove the isolated world's accessor, but token access after phone approval has not been checked against a live login here. There is no LevelDB fallback in this implementation. If this accessor stops working, update capture and its tests before relying on the image.

The service worker accepts only top-frame messages from this extension on Discord's login/channels pages, validates them again, and POSTs reports to Next's loopback endpoint with `x-login-secret`. It submits a token once; the server independently consumes that browser's authorization before verification. Do not add credential-bearing logs, page-world token bridges or captcha automation.

Tests cover report validation, secret rejection and consumption, browser ownership, cancellation during verification, idle timeout, 401 verification, REST verification followed by real database sealing, extension parsing, and process/profile cleanup using a harmless local process. They do not open Chromium or call Discord.

## Verification limits and deployment checks

The image was built with `docker build -t discord-mcp:verify .` on Docker Desktop (Linux x86_64), then run on `127.0.0.1:3920` with 1 GiB shared memory and temporary data. These checks passed:

- s6 startup, Bun as the configured unprivileged user, generated private secrets, migrations, healthy nginx, Next on `127.0.0.1:3100`, and Selkies on loopback only.
- Restart and recreation with the same data preserved the app session and did not duplicate the recorded migration. No Discord account was stored.
- The real container Chromium loaded Discord's logged-out login page. The bundled extension decoded its QR and reported it through the secret-protected loopback endpoint; the dashboard rendered its own crisp SVG.
- A separate isolated logged-out browser confirmed the live QR panel selectors and decoded the current SVG using the extension's exact QR reader. The Selkies WebSocket streamed the container's login screen successfully.
- Stream assets and API requests returned 401 for anonymous users, 403 for another app user, and 200 for the owner; a competing login returned 409. The internal report route returned 404 through nginx.
- Cancellation closed Chromium, deleted the RAM profile including the extension config and crash data, and rejected the old report secret with 403. Chromium did not create persistent configuration outside that profile after the crash-path fix.
- Compose configuration and Unraid XML parsed, and the extension, startup and migration bundles compiled. The verification container, anonymous volumes, temporary data and browser tabs were removed afterward.

No real Discord login or token-authenticated API request was made. Scan confirmation and captcha selectors, isolated-world token capture after approval, and the full phone approval path remain unverified. They require a manual check with the owner on the deployment host. The 15-minute timeout is covered by the state-machine test with a shorter injected duration; the full wall-clock timeout was not waited out in Docker.

After building on the server:

1. Confirm the image starts as the configured PUID/PGID, generates or reuses secrets, migrates successfully, and serves nginx on port 3000 while Bun listens only on `127.0.0.1:3100`.
2. Confirm `/dev/shm` has 1 GiB available, the browser profile is created there with private permissions, and the browser follows the page's light/dark scheme.
3. Open an unpaired dashboard. Check the crisp QR, scan-to-avatar transition, phone approval, and arrival at Account/Agents. If Discord asks for a captcha, solve it in the stream and confirm completion.
4. Check that signed-out users and another app user cannot fetch stream assets or upgrade its WebSocket, that another user receives a busy error during login, and that `/api/internal/login-report` returns 404 through nginx.
5. Check that finishing, leaving the page, retrying and the 15-minute timeout close Chromium and remove the profile, including `config.json`. Confirm the saved account still works after a container restart.

The app's existing private Discord REST operations, cross-session presence rules and each example client's live OAuth setup are also outside this local verification.
