<p align="center">
  <img src="assets/icon.svg" width="72" height="72" alt="discord-mcp logo">
</p>

<h1 align="center">discord-mcp</h1>

<p align="center">
  Your Discord accounts, available to your AI agents over MCP.<br>
  Self-hosted in one Docker container, reachable only over your tailnet.
</p>

## Quick start

From this checkout on a Docker host on your tailnet, with MagicDNS and HTTPS certificates enabled:

```sh
cp .env.selfhost.example .env   # set DISCORD_MCP_URL=https://<machine>.<tailnet>.ts.net:6443
docker compose up -d --build
tailscale serve --bg --https=6443 http://127.0.0.1:6480
```

Open that address. In Discord on your phone, go to **Settings > Scan QR Code**, scan, and confirm the login. If Discord asks for a captcha, the page shows the login browser with "Discord wants a captcha. Solve it below." Solve it there. The container includes Chromium and needs 1 GiB of shared memory (configured in Compose and the Unraid template). Then connect your agent:

```sh
claude mcp add --transport http discord https://<machine>.<tailnet>.ts.net:6443/api/mcp
```

Approve its access in your browser. Reads use REST with no online session. Optional presence on writes is off by default.

To use more than one Discord account, choose **Add account** on the dashboard and log in to the other account. Each agent connection acts as one account, picked on the approval page. See [Agents](docs/agents.md#several-discord-accounts).

## Docs

- [Self-hosting](docs/self-hosting.md): Docker, Unraid, settings, backups
- [Agents](docs/agents.md): clients, tools, scopes, presence
- [Security](docs/security.md): server-held keys, account risk, logout
- [Development](docs/development.md): setup, tests, layout, verification limits

AGPL-3.0. Based on the owner's [openrcs](https://github.com/AugusDogus/openrcs) shell and [discord-selfbot-mcp](https://github.com/AugusDogus/discord-selfbot-mcp) tools.
