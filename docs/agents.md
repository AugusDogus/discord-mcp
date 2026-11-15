# Agents

Add `https://<machine>.<tailnet>.ts.net:6443/api/mcp` as a Streamable HTTP MCP server. The agent must be able to reach your tailnet. The app implements OAuth discovery, dynamic client registration, PKCE S256, rotating refresh tokens and per-client revocation. Approve access in the browser when prompted.

## Clients

Claude Code:

```sh
claude mcp add --transport http discord https://<machine>.<tailnet>.ts.net:6443/api/mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.discord]
url = "https://<machine>.<tailnet>.ts.net:6443/api/mcp"
```

Then run `codex mcp login discord`.

Cursor, in its MCP configuration:

```json
{
  "mcpServers": {
    "discord": {
      "url": "https://<machine>.<tailnet>.ts.net:6443/api/mcp"
    }
  }
}
```

For OpenCode, use a remote MCP entry with this URL and complete its OAuth flow. For a self-hosted Executor or another MCP gateway, add the same URL as a remote server from a tailnet-connected installation. Client setup examples are configuration references; live client authorization has not been verified in this implementation pass.

The dashboard lists authorized clients under **Agents**. **Revoke** disconnects one client. **Log out** signs out the stored Discord session and removes every agent grant. Reconnecting after logout requires new approval.

## Scopes and tools

`discord:read` permits all read tools. `discord:write` permits actions as your account. Scopes are checked both at the HTTP layer and inside each tool. A write grant does not imply read access. Tools with internal reads still require only their declared write scope, for example checking ownership before deleting a message.

Call `get_status` first. It returns `kind: "login"` when scanning is needed. A connected account reports `health: "verified"` or `"unknown"`, its profile, presence preference and last verification time. A `/users/@me` check is cached for 60 seconds. A 401 marks the login rejected, closes any gateway session, and causes the dashboard to return to QR login. Other failures preserve the account and report unknown health.

| Tool | Scope | Purpose |
| --- | --- | --- |
| `get_status` | read | Account and cached token health |
| `discord_get_account` | read | Stored account profile and presence preference |
| `discord_list_guilds` | read | Paginated guild inventory |
| `discord_list_guild_channels` | read | Channels in a guild |
| `discord_list_dms` | read | DMs and group DMs |
| `discord_get_user` | read | User profile |
| `discord_fetch_messages` | read | Up to 100 messages, with before/after cursors |
| `discord_fetch_message` | read | One message |
| `discord_search_messages` | read | Discord server-side search with author, content and other filters |
| `discord_get_guild_layout` | read | Ordered guild folders |
| `discord_open_dm` | write | Open or retrieve a DM |
| `discord_send_message` | write | Send or reply, optionally silently |
| `discord_edit_own_message` | write | Edit a message sent by your account |
| `discord_delete_own_message` | write | Permanently delete your own message; requires `confirm: true` |
| `discord_add_reaction` | write | React as your account |
| `discord_remove_own_reaction` | write | Remove your reaction |
| `discord_create_thread` | write | Start a thread from a message |
| `discord_update_thread` | write | Rename, archive or lock a thread |
| `discord_invoke_slash_command` | write | Invoke an application command with positional string arguments |
| `discord_click_button` | write | Click an enabled component by custom ID |
| `discord_select_menu` | write | Select valid menu values by custom ID |
| `discord_join_guild` | write | Join by invite; requires `confirm: true` |
| `discord_leave_guild` | write | Leave a guild you do not own; requires `confirm: true` |
| `discord_replace_guild_layout` | write | Replace the full ordered layout; requires `confirm: true` |

Names, input schemas and behavior annotations follow [discord-selfbot-mcp](https://github.com/AugusDogus/discord-selfbot-mcp), with one deliberate input removal: local-file attachment uploads. This server is remote and cannot read files from your agent's computer. Sending needs non-empty text. Fetch tools still include attachment URLs and metadata.

Mentions are disabled on sends unless `allowMentions: true`; edits disable mentions too. Destructive calls reject `confirm: false` before requesting a target. Guild layout replacement requires every current guild exactly once and uses Discord's data version to detect concurrent changes. Its settings patch contains only guild folders and ordering.

Interactions return `submitted: true` after Discord accepts the request. Fetch messages to read the result. Completing modals, attachment arguments and command autocomplete are unavailable; use Discord for those. Slash arguments support strings, numbers, booleans, IDs and declared choices, including subcommands. REST failures are returned explicitly. Writes are never retried automatically because they may already have reached Discord.

## Presence

All reads use REST with the stored token. They never open a gateway, including account health checks and reads made while the presence toggle is enabled. With the default setting, REST writes also open no gateway.

Slash commands, buttons and select menus need a gateway session ID. They open a session on demand, identify as `invisible`, and disconnect after two minutes without an active action. Closing the page is not required. The app does not keep a background Discord connection alive after that deadline.

**Show me online when an agent sends or reacts** is off by default. When enabled, an agent write opens or reuses an `online` session for three idle minutes. This applies to all write tools, including edits, thread changes and guild organization. Turning the setting off immediately disconnects the app's existing session. The app never updates your saved Discord status setting.

How Discord merges presence from multiple simultaneous sessions has not been verified. Invisible interaction sessions may affect what your other clients display. The default path stays REST-only whenever possible so ordinary reads and writes do not contribute a gateway presence. Only your own clients contribute presence during those REST operations. Interaction transport and Discord's current private API behavior have been tested against fakes, not a live account.
