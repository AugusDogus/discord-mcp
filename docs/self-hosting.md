# Self-hosting

Run one container on a Docker host already connected to your tailnet. The image runs Next.js standalone on Bun behind nginx on container port 3000. It includes a real Chromium and the LinuxServer Selkies desktop for Discord login. The verified Linux amd64 image is about 1.1 GiB uncompressed. Allow additional disk space for downloads and build cache.

```text
Browser or agent on your tailnet
  -> Tailscale Serve on the host, HTTPS :6443
  -> host loopback 127.0.0.1:6480
  -> nginx in the container :3000
     /                  -> Next on Bun, 127.0.0.1:3100 -> /data
     /login-browser/    -> authenticated Selkies stream
     Chromium profile   -> /dev/shm/discord-mcp-browser (RAM)
```

## Docker Compose

Enable MagicDNS and HTTPS certificates in your Tailscale admin console. From the source checkout:

```sh
cp .env.selfhost.example .env
# Edit .env: set DISCORD_MCP_URL and the data directory's PUID/PGID.
docker compose up -d --build
tailscale serve --bg --https=6443 http://127.0.0.1:6480
```

Set `DISCORD_MCP_URL` to `https://<machine>.<tailnet>.ts.net:6443`. Open it from a device signed in as a tailnet user. Your Tailscale identity signs you into the app. Scan the Discord QR from **Settings > Scan QR Code** on your phone, then confirm. Discord refreshes its QR in the real browser, and the page renders the decoded URL as a crisp SVG. When Discord shows a captcha, the same stage switches to the live browser with "Discord wants a captcha. Solve it below." Solve it there and the login continues. The switch waits until the captcha is actually visible, so Discord's email and password form is not shown while the captcha loads. If no QR, confirmation or captcha is recognized for 15 seconds, the stage also shows the live browser so you can finish the login yourself.

To add another Discord account, choose **Add account** on the dashboard and log in the same way.

Compose publishes only `127.0.0.1:6480` and creates a separate Docker network. Sign-in trusts the identity headers set by Tailscale Serve. Keep direct access restricted to trusted host processes and containers. Publishing on your LAN or attaching untrusted containers to this network lets them impersonate a tailnet user. Use Serve, keep Funnel off, and keep the app's port off other interfaces.

Tagged devices have no user identity for dashboard sign-in. An agent on a tagged device can use an OAuth grant approved from your personal device. Cloud-hosted agents need their own route onto your tailnet.

## Unraid

Use the host Tailscale plugin. With this source checkout on the server:

```sh
docker build -t discord-mcp:local .
docker network create discord-mcp
cp unraid/discord-mcp.xml /boot/config/plugins/dockerMan/templates-user/my-discord-mcp.xml
```

In **Docker > Add Container**, choose **discord-mcp**. Keep **Repository** `discord-mcp:local`, **Network** `discord-mcp`, and **Extra Parameters** `--shm-size=1g -p 127.0.0.1:6480:3000`. Set `DISCORD_MCP_URL` to the server's Serve origin. The template uses `/mnt/user/appdata/discord-mcp`, PUID 99 and PGID 100. Leave the container's Tailscale integration off.

Apply, then run on the host:

```sh
tailscale serve --bg --https=6443 http://127.0.0.1:6480
```

The template uses a locally built image. No published registry image is required.

## Login browser

Compose sets `shm_size: 1gb`; a manual Docker run or Unraid needs `--shm-size=1g`. Chromium and its disposable profile share this RAM-backed space. Docker's small default shared-memory allocation is insufficient. Do not bind-mount the profile onto persistent storage. RAM-only storage can still be paged out by a host that uses swap, so apply your host's normal disk encryption policy.

Opening an unpaired dashboard automatically launches one Chromium on `https://discord.com/login`, in the same light or dark scheme as the page. No remote debugging port is opened and no captcha avoidance flags are added. One signed-in user owns the browser at a time. nginx checks the app session and ownership before serving stream files or upgrading its WebSocket. The desktop has file transfers, terminals, command execution, sharing, audio and printing disabled; clipboard access is input only.

The browser closes after successful token verification and sealing, cancellation, an error, or 15 minutes. Its profile and the per-launch extension secret live under `/dev/shm/discord-mcp-browser`, are removed after closing, and are cleared at container startup. Only the sealed token and minimal account profile are persisted in the existing database. If profile cleanup fails, new browsers stay blocked until cleanup succeeds or the container restarts.

The extension reports directly to Next on `127.0.0.1:3100`; nginx refuses that internal report path. Keep Next and all Selkies ports private. Publish only nginx's port 3000 on the host's loopback as shown above.

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

The Selkies s6 initialization applies PUID/PGID to the unprivileged `abc` user and assigns `/data` to that user. The app prepares secrets and runs migrations as `abc` before starting Bun. Secrets are created with mode 0600 and kept across restarts. Existing secret files are never silently replaced. Environment secret overrides take precedence; add them through the Unraid template or a Compose override, and back up those values separately. No secrets are baked into the image.

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
| An account is marked signed out by Discord | Discord rejected its token; choose **Add account** and log in to that account again. Its agents reconnect automatically |
| An account shows as an unreadable login | The server key no longer opens it; log it out, then add the account again and reconnect its agents |
| Discord is temporarily unavailable | Reads report the failure; the account is kept and health is marked unknown. Retry later |
| An interaction opens a modal | Finish it in Discord; this app submits interactions and exposes message results through fetch tools |
| Discord asks for account verification or a CAPTCHA during login | Complete it in the streamed browser on the login page; a human solves it on discord.com |
| Login browser is blank or crashes | Check the Selkies and Chromium startup logs, and confirm `shm_size: 1gb` or `--shm-size=1g` |
| Login stays in the stream after reaching Discord | Token capture may need updating for Discord's current page; see the extension verification limits in [Development](development.md). Do not paste or log a token |
