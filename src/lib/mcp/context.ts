import type { McpServer } from "@modelcontextprotocol/server";
import type { McpAuth } from "@/lib/oauth";

/**
 * Per-request context for the MCP server: the verified access token's user,
 * grant, client and scopes. Tools act only for `auth.userId`, check
 * `auth.scopes` themselves, and never log or return the Discord token.
 */
export type DiscordMcpContext = {
  readonly auth: McpAuth;
};

/** Registers tools on a per-request server instance. */
export type DiscordToolRegistrar = (server: McpServer, ctx: DiscordMcpContext) => void;
