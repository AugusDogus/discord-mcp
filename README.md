<p align="center">
  <img src="assets/icon.svg" width="72" height="72" alt="discord-mcp logo">
</p>

<h1 align="center">discord-mcp</h1>

<p align="center">
  Your Discord accounts, available to your AI agents over MCP.<br>
  Self-hosted in one Docker container, reachable only over your tailnet.
</p>

<div align="center"><video src="https://github.com/user-attachments/assets/8f9c71f5-aa1e-487e-b191-5146ff0719c0" width="1280" height="800" title="discord-mcp"></video></div>

## Quick start

On a Docker host that's on your tailnet (MagicDNS and HTTPS certificates on):

```sh
git clone https://github.com/AugusDogus/discord-mcp && cd discord-mcp
cp .env.selfhost.example .env      # set DISCORD_MCP_URL=https://<machine>.<tailnet>.ts.net:6443
docker compose up -d --build
tailscale serve --bg --https=6443 http://127.0.0.1:6480
```

Open that address and scan the QR with Discord on your phone
(**Settings > Scan QR Code**). Then add `https://<machine>.<tailnet>.ts.net:6443/api/mcp`
to your agent and approve it in the browser, for example:

```sh
claude mcp add --transport http discord https://<machine>.<tailnet>.ts.net:6443/api/mcp
```

## Docs

- [Self-hosting](docs/self-hosting.md): Docker, Unraid, the login browser and captchas, settings, backups
- [Agents](docs/agents.md): clients, several Discord accounts, tools, scopes, presence
- [Security](docs/security.md): server-held keys, account risk, logout
- [Development](docs/development.md): setup, tests, layout, the demo video, verification limits

AGPL-3.0. Based on the owner's [openrcs](https://github.com/AugusDogus/openrcs) shell and
[discord-selfbot-mcp](https://github.com/AugusDogus/discord-selfbot-mcp) tools.
