import type { McpServer } from "@modelcontextprotocol/server";
import type { DiscordMcpContext } from "./context";
import { ToolScope } from "./scopes";
import { ToolRunner } from "./tool-runner";
import * as z from "zod/v4";
import { snowflake, confirm, readAnnotations, writeAnnotations, destructiveAnnotations } from "./tool-schema";

export function registerMessagesTools(server: McpServer, ctx: DiscordMcpContext): void {
  server.registerTool(
    "discord_fetch_messages",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "Fetch messages",
      description: "Fetch a page of messages from a guild channel, thread, or DM.",
      inputSchema: z.object({
        channelId: snowflake,
        limit: z.number().int().min(1).max(100).default(50),
        before: snowflake.optional(),
        after: snowflake.optional(),
      }),
      annotations: readAnnotations,
    },
    async ({ channelId, limit, before, after }) =>
      ToolRunner.run(
        ctx,
        ToolScope.read,
        async (discord) => await discord.fetchMessages(channelId, limit, before, after),
      ),
  );
  server.registerTool(
    "discord_fetch_message",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "Fetch message",
      description: "Fetch one Discord message by channel and message ID.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
      }),
      annotations: readAnnotations,
    },
    async ({ channelId, messageId }) =>
      ToolRunner.run(ctx, ToolScope.read, async (discord) => await discord.fetchMessage(channelId, messageId)),
  );
  server.registerTool(
    "discord_search_messages",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.read),
      title: "Search messages",
      description: "Search messages in a guild channel or DM using Discord's server-side search.",
      inputSchema: z.object({
        channelId: snowflake,
        content: z.string().optional(),
        authorIds: z.array(snowflake).optional(),
        mentionIds: z.array(snowflake).optional(),
        has: z.array(z.enum(["link", "embed", "file", "video", "image", "sound", "sticker"])).optional(),
        maxId: snowflake.optional(),
        minId: snowflake.optional(),
        pinned: z.boolean().optional(),
        includeNsfw: z.boolean().default(false),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(25).default(25),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
      }),
      annotations: readAnnotations,
    },
    async ({ channelId, ...search }) =>
      ToolRunner.run(ctx, ToolScope.read, async (discord) => await discord.searchMessages(channelId, search)),
  );
  server.registerTool(
    "discord_send_message",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Send message",
      description:
        "Send a message or reply in a guild channel, thread, or DM. Mentions are disabled unless allowMentions is true. Local-file attachments are unavailable on this remote server.",
      inputSchema: z.object({
        channelId: snowflake,
        content: z.string().max(2_000).optional(),
        replyToMessageId: snowflake.optional(),
        allowMentions: z.boolean().default(false),
        silent: z.boolean().default(false),
      }),
      annotations: writeAnnotations,
    },
    async ({ channelId, ...message }) =>
      ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.sendMessage(channelId, message)),
  );
  server.registerTool(
    "discord_edit_own_message",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Edit own message",
      description: "Edit a message sent by the logged-in account.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
        content: z.string().max(2_000),
      }),
      annotations: {
        ...writeAnnotations,
        idempotentHint: true,
      },
    },
    async ({ channelId, messageId, content }) =>
      ToolRunner.run(
        ctx,
        ToolScope.write,
        async (discord) => await discord.editOwnMessage(channelId, messageId, content),
      ),
  );
  server.registerTool(
    "discord_delete_own_message",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Delete own message",
      description: "Permanently delete a message sent by the logged-in account.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
        confirm,
      }),
      annotations: destructiveAnnotations,
    },
    async ({ channelId, messageId, confirm: confirmed }) =>
      ToolRunner.run(
        ctx,
        ToolScope.write,
        async (discord) => await discord.deleteOwnMessage(channelId, messageId, confirmed),
      ),
  );
  server.registerTool(
    "discord_add_reaction",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Add reaction",
      description: "Add the logged-in account's reaction to a message.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
        emoji: z.string().min(1),
      }),
      annotations: writeAnnotations,
    },
    async ({ channelId, messageId, emoji }) =>
      ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.addReaction(channelId, messageId, emoji)),
  );
  server.registerTool(
    "discord_remove_own_reaction",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Remove own reaction",
      description: "Remove the logged-in account's reaction from a message.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
        emoji: z.string().min(1),
      }),
      annotations: {
        ...writeAnnotations,
        idempotentHint: true,
      },
    },
    async ({ channelId, messageId, emoji }) =>
      ToolRunner.run(
        ctx,
        ToolScope.write,
        async (discord) => await discord.removeOwnReaction(channelId, messageId, emoji),
      ),
  );
  server.registerTool(
    "discord_create_thread",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Create thread",
      description: "Create a Discord thread from an existing message.",
      inputSchema: z.object({
        channelId: snowflake,
        messageId: snowflake,
        name: z.string().min(1).max(100),
      }),
      annotations: writeAnnotations,
    },
    async ({ channelId, messageId, name }) =>
      ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.createThread(channelId, messageId, name)),
  );
  server.registerTool(
    "discord_update_thread",
    {
      scopeChallenge: ToolScope.challenge(ToolScope.write),
      title: "Update thread",
      description: "Rename, archive, unarchive, lock, or unlock a Discord thread.",
      inputSchema: z.object({
        threadId: snowflake,
        name: z.string().min(1).max(100).optional(),
        archived: z.boolean().optional(),
        locked: z.boolean().optional(),
      }),
      annotations: writeAnnotations,
    },
    async ({ threadId, ...options }) =>
      ToolRunner.run(ctx, ToolScope.write, async (discord) => await discord.updateThread(threadId, options)),
  );
}
