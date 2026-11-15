import type { McpServer } from "@modelcontextprotocol/server";
import type { DiscordMcpContext } from "./context";
import { ToolScope } from "./scopes";
import { ToolRunner } from "./tool-runner";
import * as z from "zod/v4";
import { snowflake, confirm, readAnnotations, writeAnnotations, destructiveAnnotations } from "./tool-schema";

export function registerGuildsTools(server: McpServer, ctx: DiscordMcpContext): void {
  server.registerTool(
    "discord_list_guilds",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "List Discord guilds",
      description: "List every guild available to the logged-in account.",
      annotations: readAnnotations,
    },
    async () => ToolRunner.run(ctx, ToolScope.read, async (discord) => discord.listGuilds()),
  );
  server.registerTool(
    "discord_list_guild_channels",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "List guild channels",
      description: "List channels in a Discord guild.",
      inputSchema: z.object({ guildId: snowflake }),
      annotations: readAnnotations,
    },
    async ({ guildId }) =>
      ToolRunner.run(ctx, ToolScope.read, async (discord) => await discord.listGuildChannels(guildId)),
  );
  server.registerTool(
    "discord_join_guild",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Join guild",
      description: "Join a Discord guild using an invite URL or code.",
      inputSchema: z.object({
        invite: z.string().min(1),
        confirm,
      }),
      annotations: writeAnnotations,
    },
    async ({ invite, confirm: confirmed }) =>
      ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.joinGuild(invite, confirmed)),
  );
  server.registerTool(
    "discord_leave_guild",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Leave guild",
      description: "Permanently leave a Discord guild. Guilds owned by the account cannot be left.",
      inputSchema: z.object({
        guildId: snowflake,
        confirm,
      }),
      annotations: destructiveAnnotations,
    },
    async ({ guildId, confirm: confirmed }) =>
      ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.leaveGuild(guildId, confirmed)),
  );
  server.registerTool(
    "discord_get_guild_layout",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "Get guild layout",
      description: "Read the account's ordered guild folders. Anonymous one-guild entries are ungrouped guilds.",
      annotations: readAnnotations,
    },
    async () => ToolRunner.run(ctx, ToolScope.read, async (discord) => await discord.getGuildLayout()),
  );
  server.registerTool(
    "discord_replace_guild_layout",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Replace guild layout",
      description:
        "Replace the complete ordered guild and folder layout. Every current guild ID must appear exactly once. Omit id, name, and color for an ungrouped guild.",
      inputSchema: z.object({
        folders: z
          .array(
            z.object({
              id: snowflake.describe("Existing folder ID. Omit to create a folder.").optional(),
              name: z.string().max(100).optional(),
              color: z.number().int().min(0).max(0xffffff).optional(),
              guildIds: z.array(snowflake).min(1),
            }),
          )
          .min(1),
        confirm,
      }),
      annotations: destructiveAnnotations,
    },
    async ({ folders, confirm: confirmed }) =>
      ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.replaceGuildLayout(folders, confirmed)),
  );
}
