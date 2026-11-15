# Self-hosting

Run one container on a Docker host already connected to your tailnet. The image runs Next.js standalone on Node 22, listens on container port 3000, and needs no browser or reverse proxy inside the container.

```text
Browser or agent on your tailnet
  -> Tailscale Serve on the host, HTTPS :6443
  -> host loopback 127.0.0.1:6480
  -> discord-mcp container :3000
  -> /data (SQLite and generated secrets)
```

## Docker Compose

Enable MagicDNS and HTTPS certificates in your Tailscale admin console. From the source checkout:

```sh
cp .env.selfhost.example .env
# Edit .env: set DISCORD_MCP_URL and the data directory's PUID/PGID.
docker compose up -d --build
tailscale serve --bg --https=6443 http://127.0.0.1:6480
```

Set `DISCORD_MCP_URL` to `https://<machine>.<tailnet>.ts.net:6443`. Open it from a device signed in as a tailnet user. Your Tailscale identity signs you into the app. Scan the Discord QR from **Settings > Scan QR Code** on your phone, then confirm. Expired and cancelled QR codes refresh automatically.

Compose publishes only `127.0.0.1:6480` and creates a separate Docker network. Sign-in trusts the identity headers set by Tailscale Serve. Keep direct access restricted to trusted host processes and containers. Publishing on your LAN or attaching untrusted containers to this network lets them impersonate a tailnet user. Use Serve, keep Funnel off, and keep the app's port off other interfaces.

Tagged devices have no user identity for dashboard sign-in. An agent on a tagged device can use an OAuth grant approved from your personal device. Cloud-hosted agents need their own route onto your tailnet.

## Unraid

Use the host Tailscale plugin. With this source checkout on the server:

```sh
docker build -t discord-mcp:local .
docker network create discord-mcp
cp unraid/discord-mcp.xml /boot/config/plugins/dockerMan/templates-user/my-discord-mcp.xml
```

In **Docker > Add Container**, choose **discord-mcp**. Keep **Repository** `discord-mcp:local`, **Network** `discord-mcp`, and **Extra Parameters** `-p 127.0.0.1:6480:3000`. Set `DISCORD_MCP_URL` to the server's Serve origin. The template uses `/mnt/user/appdata/discord-mcp`, PUID 99 and PGID 100. Leave the container's Tailscale integration off.

Apply, then run on the host:

```sh
tailscale serve --bg --https=6443 http://127.0.0.1:6480
```

The template uses a locally built image. No published registry image is required.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_MCP_URL` | required | Public Serve origin, port included, no path or query; also the OAuth issuer |
| `DISCORD_MCP_PORT` | `6480` | Compose loopback port |
| `DISCORD_MCP_DATA` | `./data` | Compose host directory mounted at `/data` |
| `PUID` / `PGID` | `1000` / `1000` | App user and group; Unraid template uses `99` / `100` |
| `KEY_PEPPER` | generated | Base64 of 32 bytes, persisted at `/data/secrets/key-pepper` |
| `BETTER_AUTH_SECRET` | generated | Browser session secret, persisted at `/data/secrets/auth-secret` |
| `DATABASE_URL` | `file:/data/discord-mcp.db` | Container database URL |

The root entrypoint assigns `/data` to PUID/PGID and then drops privileges. Secrets are created with mode 0600 and kept across restarts. Existing secret files are never silently replaced. Environment secret overrides take precedence; add them through the Unraid template or a Compose override, and back up those values separately. No secrets are baked into the image.

Migrations run before the server on every start. A failed migration prevents startup. Fix the reported issue and restart; already recorded migrations are skipped.

## Backups and updates

Stop the container before copying the entire data directory, including `secrets/`. A complete copy reveals the Discord token, so encrypt backups or keep them private. See [Security](security.md).

To update a Compose install:

```sh
docker compose up -d --build
```

For Unraid, rebuild `discord-mcp:local` and recreate the container with the same data mount. To move hosts, copy the complete data directory and any secret overrides. Changing the Serve origin requires reconnecting agents to the new MCP address. Losing or rotating `KEY_PEPPER` requires scanning again and authorizing agents again. Losing only `BETTER_AUTH_SECRET` signs browsers out.

## Troubleshooting

| Symptom | Next step |
| --- | --- |
| No Tailscale identity at sign-in | Open the Serve HTTPS address from a device signed in as a user; tagged devices cannot sign in |
| Address is unreachable | Check `tailscale serve status`, MagicDNS, HTTPS certificates and tailnet access rules for port 6443 |
| Startup cannot write secrets or SQLite | Check the `/data` mount, available space and PUID/PGID ownership |
| Dashboard returns to a QR | Discord rejected the stored token, or the server key no longer opens it; scan and confirm again |
| Discord is temporarily unavailable | Reads report the failure; the account is kept and health is marked unknown. Retry later |
| An interaction opens a modal | Finish it in Discord; this app submits interactions and exposes message results through fetch tools |
| Discord asks for account verification or a CAPTCHA | Complete it in the official client; the app does not bypass it |
