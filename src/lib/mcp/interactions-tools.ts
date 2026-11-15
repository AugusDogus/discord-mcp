import type { McpServer } from "@modelcontextprotocol/server";
import type { DiscordMcpContext } from "./context";
import { ToolScope } from "./scopes";
import { ToolRunner } from "./tool-runner";
import * as z from "zod/v4";
import { snowflake, writeAnnotations } from "./tool-schema";

export function registerInteractionsTools(server: McpServer, ctx: DiscordMcpContext): void {
  server.registerTool(
    "discord_invoke_slash_command",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Invoke slash command",
      description: "Invoke an application slash command. commandName may include subcommands separated by spaces.",
      inputSchema: z.object({
        channelId: snowflake,
        applicationId: snowflake,
        commandName: z.string().min(1),
        args: z.array(z.string()).default([]),
      }),
      annotations: writeAnnotations,
    },
    async ({ channelId, applicationId, commandName, args }) =>
      ToolRunner.run(
        ctx,
        ToolScope.write,
        async (discord) => await discord.invokeSlashCommand(channelId, applicationId, commandName, args),
      ),
  );
  server.registerTool(
    "discord_click_button",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Click message button",
      description: "Click a Discord message button by its custom ID.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
        customId: z.string().min(1),
      }),
      annotations: writeAnnotations,
    },
    async ({ channelId, messageId, customId }) =>
      ToolRunner.run(
        ctx,
        ToolScope.write,
        async (discord) => await discord.clickButton(channelId, messageId, customId),
      ),
  );
  server.registerTool(
    "discord_select_menu",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Select message menu",
      description: "Choose values in a Discord message select menu.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
        customId: z.string().min(1),
        values: z.array(z.string()).min(1),
      }),
      annotations: writeAnnotations,
    },
    async ({ channelId, messageId, customId, values }) =>
      ToolRunner.run(
        ctx,
        ToolScope.write,
        async (discord) => await discord.selectMenu(channelId, messageId, customId, values),
      ),
  );
}
