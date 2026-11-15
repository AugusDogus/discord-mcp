import { requireScopes, type CallToolResult } from "@modelcontextprotocol/server";
import { McpScope } from "@/lib/oauth/scopes";
import type { DiscordMcpContext } from "./context";

/**
 * Scope checks for tools. Each tool declares the scope it needs twice:
 * `challenge` lets the HTTP layer answer 403 insufficient_scope when the
 * route passes authInfo, and `check` is the in-tool guard that always runs.
 */
const purpose: Record<McpScope, string> = {
  "discord:read": "read your Discord servers, channels, DMs and messages",
  "discord:write": "act as you on Discord",
};

/** `null` when granted, else an isError result naming the missing scope and the fix. */
const check = (ctx: DiscordMcpContext, scope: McpScope): CallToolResult | null =>
  ctx.auth.scopes.includes(scope)
    ? null
    : {
        isError: true,
        content: [
          {
            type: "text",
            text: `This tool needs the "${scope}" scope (to ${purpose[scope]}), but this client was authorized with ${
              ctx.auth.scopes.length > 0 ? `only: ${ctx.auth.scopes.join(", ")}` : "no Discord scopes"
            }. Nothing was done. Re-authorize the client with "${scope}" (disconnect and reconnect it, then approve the scope in the discord-mcp browser window).`,
          },
        ],
      };

export const ToolScope = {
  read: McpScope.read,
  write: McpScope.write,
  check,
  challenge: (scope: McpScope) => requireScopes(scope),
} as const;
