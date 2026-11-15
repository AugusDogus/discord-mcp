import type { Result } from "better-result";
import type { DiscordService } from "@/lib/discord/service";
import type { AccountHealth } from "@/lib/discord/account-health";
import type { DiscordAccountKey } from "@/lib/discord/account-store";
import type { McpServer } from "@modelcontextprotocol/server";
import type { McpAuth } from "@/lib/oauth";

/**
 * Per-request context for the MCP server: the verified access token's user,
 * grant, Discord account, client and scopes. Tools act only as the grant's
 * account (`auth.discordAccountId` of `auth.userId`), check `auth.scopes`
 * themselves, and never log or return the Discord token.
 */
export type DiscordMcpContext = {
  readonly auth: McpAuth;
  readonly service?: (account: DiscordAccountKey) => Promise<Result<DiscordService, { readonly message: string }>>;
  readonly health?: (account: DiscordAccountKey) => Promise<Result<AccountHealth, { readonly message: string }>>;
};

/** Registers tools on a per-request server instance. */
export type DiscordToolRegistrar = (server: McpServer, ctx: DiscordMcpContext) => void;
