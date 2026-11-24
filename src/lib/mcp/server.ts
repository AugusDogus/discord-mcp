import { registerAccountTools } from "./account-tools";
import { registerMessagesTools } from "./messages-tools";
import { registerInteractionsTools } from "./interactions-tools";
import { registerGuildsTools } from "./guilds-tools";
import { registerPollsTools } from "./polls-tools";
import { McpServer } from "@modelcontextprotocol/server";
import type { DiscordMcpContext, DiscordToolRegistrar } from "./context";

export type { DiscordMcpContext, DiscordToolRegistrar } from "./context";

const instructions = [
  "discord-mcp acts as the user's own Discord account: the one chosen when this connection was approved.",
  "Call get_status first. If the account is not logged in, ask the user to log in from the discord-mcp dashboard.",
].join("\n");

const registrars: readonly DiscordToolRegistrar[] = [registerAccountTools, registerMessagesTools, registerPollsTools, registerInteractionsTools, registerGuildsTools];

/**
 * Builds a fresh MCP server bound to one authenticated grant. Called once per
 * HTTP request by the `/api/mcp` route (stateless serving).
 */
export const createDiscordMcpServer = (ctx: DiscordMcpContext): McpServer => {
  const server = new McpServer({ name: "discord-mcp", version: "0.1.0" }, { instructions });
  for (const register of registrars) register(server, ctx);
  return server;
};
