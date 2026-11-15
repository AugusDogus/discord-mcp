import type { Result } from "better-result";
import type { DiscordService } from "@/lib/discord/service";
import type { AccountHealth } from "@/lib/discord/account-health";
import type { McpServer } from "@modelcontextprotocol/server";
import type { McpAuth } from "@/lib/oauth";

/**
 * Per-request context for the MCP server: the verified access token's user,
 * grant, client and scopes. Tools act only for `auth.userId`, check
 * `auth.scopes` themselves, and never log or return the Discord token.
 */
export type DiscordMcpContext = {
  readonly auth: McpAuth;
  readonly service?: (userId: string) => Promise<Result<DiscordService, { readonly message: string }>>;
  readonly health?: (userId: string) => Promise<Result<AccountHealth, { readonly message: string }>>;
};

/** Registers tools on a per-request server instance. */
export type DiscordToolRegistrar = (server: McpServer, ctx: DiscordMcpContext) => void;
