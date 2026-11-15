# Security

Discord prohibits user-account automation, and using this app can get the account suspended.

This app is for its owner's self-hosted account on a private tailnet. Tailscale Serve supplies the browser identity. Better Auth issues the browser session, and the app's OAuth server grants agents separate `discord:read` and `discord:write` access. Browser login start, polling, cancellation and account changes require a signed-in session and the app's exact origin. The dashboard cannot be framed.

## Stored data and keys

The Discord token and profile are sealed with a random 32-byte per-user data encryption key (DEK), using AES-256-GCM. Associated data binds each envelope to its user, table, row and column. The server holds a wrapped copy of the DEK in `user_key`, derived from `KEY_PEPPER` with HKDF-SHA256 and sealed with AES-256-GCM. This lets the server act without an open browser.

`KEY_PEPPER` lives in `/data/secrets/key-pepper` unless provided by the operator. The database lives beside it in `/data/discord-mcp.db`. A copy of the complete `/data` directory reveals the Discord token and profile. At-rest encryption does not protect against a running-server compromise or someone with the database and server secret. Keep backups private or encrypt them.

The database alone exposes tailnet identities, row IDs, timestamps, account flags, client registrations and grant scopes. Without `KEY_PEPPER`, it does not open sealed Discord credentials. Messages and attachment bytes are not cached in the database. They pass through server memory to the agent, which may store them independently. Avatar images load from Discord's CDN.

## Discord login browser

Login runs in a real Chromium inside the container, streamed by Selkies. The owner solves any captcha directly on discord.com. There is no captcha bypass, fingerprint override, remote debugging port or automated form submission. The browser is exclusive to one signed-in user, and nginx uses `auth_request` on both stream assets and WebSocket upgrades to check the session and current ownership. Only the host's trusted proxy should reach nginx. The desktop disables file transfers, terminals, command execution, sharing, audio, printing and clipboard export.

Each login gets a private profile in `/dev/shm` and a private copy of the bundled MV3 extension. The server writes a fresh random secret into that copy's `config.json`. The extension service worker sends reports directly to `127.0.0.1:3100/api/internal/login-report`; nginx blocks that endpoint externally. The server compares the secret in constant time, accepts reports only while that browser is running, and consumes its authorization when a token arrives. It never returns the secret or token through dashboard polling.

The content script reads `localStorage.getItem("token")` in its isolated world after Discord reaches `/channels` or the login page disappears, then parses the JSON string. This implementation does not read LevelDB. Before saving, the existing REST client verifies the token with `GET /api/v9/users/@me`. A 401 or a storage failure reports an error and keeps the previous account. Only a verified token is sealed by `DiscordAccountStore`.

QR reports must match `https://discord.com/ra/` followed by URL-safe identifier characters. Scanned avatars must be HTTPS on `cdn.discordapp.com`. The app renders its own QR SVG and plain name text; no Discord page markup is injected into the dashboard. Unrecognized or missing reports show the live stream after five seconds; detected captchas show it immediately.

The browser profile, login cookies, password storage, crash data, caches and extension secret stay in RAM and are wiped after completion, cancellation, failure or timeout, and at container startup. A failed cleanup blocks another launch until resolved. The host may page RAM to swap, so RAM-only storage is not a substitute for host disk encryption. The sealed token and minimal account profile remain in the database as described above. The live QR reader was verified in the container. Scan confirmation, captcha detection and isolated-world token capture after approval still require deployment validation; see [Development](development.md).

## Agent credentials

Authorization codes expire after 60 seconds and require PKCE S256. Refresh tokens rotate and expire after 90 days. Their database rows store verifiers and lifecycle metadata rather than plaintext secrets. Access tokens are sealed, live for one hour and are checked against a live grant on each HTTP request. Reuse detection can revoke the affected grant.

MCP results never include the Discord token. Discord failures report operation and status without echoing response bodies or transport exceptions. Do not add request-body, Authorization-header or WebSocket-payload logging: these carry credentials or message content. Untrusted Discord messages are data, not instructions to the agent.

A complete data copy can also forge access tokens for existing grants. A single agent token permits only that grant's scopes while valid and while the server is reachable over the tailnet. The confirmation parameter on destructive tools is an agent contract, not a separate human approval screen.

## Logout and recovery

Log out cancels the login browser and closes gateway sessions, waits behind any active agent action, POSTs `/api/v9/auth/logout` with the Discord token, and then deletes the local account row, per-user key, OAuth credentials and grants in one database batch. Other users' accounts stay intact. A 401 during logout permits cleanup because the token is already rejected. Other remote failures preserve the local rows for retry. A cleanup failure reports that local data remains so the user can retry.

Browser login saves and agent actions share the account lease with logout. Cancellation immediately invalidates the browser report secret and aborts a save waiting for the lease, and an agent waiting behind logout rechecks its grant before loading credentials. This lease and the browser/gateway managers are in memory: run one server process against a data volume. Multiple replicas sharing the database are unsupported.

Ordinary re-login keeps existing grants and the presence preference. If the server key is missing or changed, scanning replaces the unreadable Discord login. Rotating `KEY_PEPPER` also invalidates OAuth credentials, so agents need new approval. Losing only the browser signing secret requires browser sign-in again.

## Network boundary

Only Tailscale Serve should expose the app. Compose binds the host port to loopback, and Unraid's template does the same. Host processes and containers on the app's Docker network can still connect directly and must be trusted because sign-in trusts Serve's identity headers. Tailnet access rules control who can reach the HTTPS port. Do not use Tailscale Funnel for this app.

The image contains no credentials. Its s6 initialization assigns `/data` to PUID/PGID, then the unprivileged app service generates missing secrets and runs migrations before starting Bun. See [Self-hosting](self-hosting.md) for backup and recovery details. Presence behavior and verification limits are described in [Agents](agents.md).
