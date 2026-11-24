import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { DiscordMcpContext } from "./context";
import { ToolScope } from "./scopes";
import { ToolRunner } from "./tool-runner";
import { confirm, destructiveAnnotations, readAnnotations, snowflake, writeAnnotations } from "./tool-schema";

export function registerPollsTools(server: McpServer, ctx: DiscordMcpContext): void {
  server.registerTool(
    "discord_create_poll",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Create poll",
      description:
        "Post a native Discord poll in a guild channel, thread, or DM. Returns the sent message with its poll; an error means no poll was posted, or names the message Discord saved without one. Polls cannot be edited after posting.",
      inputSchema: z.object({
        channelId: snowflake,
        question: z.string().trim().min(1).max(300),
        answers: z
          .array(
            z.object({
              text: z.string().trim().min(1).max(55),
              emoji: z.string().min(1).optional().describe("A Unicode emoji, or a custom emoji as <:name:id> or name:id"),
            }),
          )
          .min(1)
          .max(10),
        durationHours: z.number().int().min(1).max(768).default(24).describe("How long the poll stays open, up to 32 days"),
        allowMultiselect: z.boolean().default(false),
        content: z.string().max(2_000).optional().describe("Message text shown above the poll; mentions are disabled"),
      }),
      annotations: writeAnnotations,
    },
    async ({ channelId, ...poll }) =>
      ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.createPoll(channelId, poll)),
  );
  server.registerTool(
    "discord_get_poll_results",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "Get poll results",
      description:
        "Vote counts for each answer of a poll message, and optionally who voted for each. Counts may shift slightly until resultsFinalized is true after the poll ends; null votes mean Discord did not report results.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
        includeVoters: z.boolean().default(false),
      }),
      annotations: readAnnotations,
    },
    async ({ channelId, messageId, includeVoters }) =>
      ToolRunner.run(
        ctx,
        ToolScope.read,
        async (discord) => await discord.getPollResults(channelId, messageId, includeVoters),
      ),
  );
  server.registerTool(
    "discord_end_poll",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "End poll",
      description: "End a poll posted by the logged-in account now, closing voting for good. Returns the ended poll.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
        confirm,
      }),
      annotations: destructiveAnnotations,
    },
    async ({ channelId, messageId, confirm: confirmed }) =>
      ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.endPoll(channelId, messageId, confirmed)),
  );
}
