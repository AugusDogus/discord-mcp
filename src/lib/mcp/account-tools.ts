import type { McpServer } from "@modelcontextprotocol/server";
import type { DiscordMcpContext } from "./context";
import { ToolScope } from "./scopes";
import { ToolRunner } from "./tool-runner";
import * as z from "zod/v4";
import { snowflake, readAnnotations, writeAnnotations } from "./tool-schema";
import { DiscordRuntime } from "@/lib/discord/runtime";

export function registerAccountTools(server: McpServer, ctx: DiscordMcpContext): void {
  server.registerTool(
    "discord_get_account",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "Get Discord account",
      description: "Get the logged-in Discord account and connection status.",
      annotations: readAnnotations,
    },
    async () => ToolRunner.run(ctx, ToolScope.read, (discord) => discord.getAccount()),
  );
  server.registerTool(
    "discord_list_dms",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "List DMs",
      description: "List direct-message and group-DM channels.",
      annotations: readAnnotations,
    },
    async () => ToolRunner.run(ctx, ToolScope.read, async (discord) => await discord.listPrivateChannels()),
  );
  server.registerTool(
    "discord_open_dm",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Open a DM",
      description: "Open or retrieve a direct-message channel with a Discord user.",
      inputSchema: z.object({ userId: snowflake }),
      annotations: writeAnnotations,
    },
    async ({ userId }) => ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.openDm(userId)),
  );
  server.registerTool(
    "discord_get_user",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "Get Discord user",
      description: "Fetch public profile details for a Discord user ID.",
      inputSchema: z.object({ userId: snowflake }),
      annotations: readAnnotations,
    },
    async ({ userId }) => ToolRunner.run(ctx, ToolScope.read, async (discord) => await discord.getUser(userId)),
  );
  server.registerTool(
    "get_status",
    {
      title: "Get Discord status",
      description: "Check the account and cached token health. If login is needed, open the discord-mcp dashboard.",
      annotations: readAnnotations,
      scopeChallenge: ToolScope.challenge(ToolScope.read),
    },
    async () => {
      const denied = ToolScope.check(ctx, ToolScope.read);
      if (denied) return denied;
      return ToolRunner.toToolResult(await (ctx.health ?? DiscordRuntime.health)(ctx.auth.userId));
    },
  );
}
