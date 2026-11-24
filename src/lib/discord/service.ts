import { Result } from "better-result";
import { z } from "zod";
import type { DiscordCredentials } from "./account-store";
import { DiscordApiSchema as Api } from "./api-schema";
import { DiscordGuildLayout, type GuildFolderInput } from "./guild-layout";
import { DiscordGuilds } from "./guilds";
import { DiscordInteractions } from "./interactions";
import { DiscordPoll, type PollInput } from "./poll";
import type { DiscordPresence } from "./presence";
import { DiscordRest, type DiscordApiError } from "./rest";

export type MessageSearch = {
  content?: string;
  authorIds?: string[];
  mentionIds?: string[];
  has?: string[];
  maxId?: string;
  minId?: string;
  pinned?: boolean;
  includeNsfw?: boolean;
  offset?: number;
  limit?: number;
  sortOrder?: "asc" | "desc";
};
export type CreatePoll = PollInput & { readonly content?: string };
export type SendMessage = { content?: string; replyToMessageId?: string; allowMentions?: boolean; silent?: boolean };
export type DiscordServiceDeps = {
  readonly rest: DiscordRest;
  readonly sessions: DiscordPresence;
  readonly credentials: DiscordCredentials;
  readonly rejected: () => Promise<Result<unknown, { readonly message: string }>>;
};

const create = ({ rest, sessions, credentials, rejected }: DiscordServiceDeps) => {
  const { record, token } = credentials;
  const fail = (operation: string, message: string) => Result.err(DiscordRest.error(operation, null, message));
  const confirmed = (value: boolean, operation: string) =>
    value
      ? null
      : fail(operation, `Set confirm to true after reviewing the target and consequences. Nothing was changed.`);
  const write = async <T>(action: () => Promise<Result<T, DiscordApiError>>): Promise<Result<T, DiscordApiError>> => {
    if (!record.presenceOnWrite) return action();
    const result = await sessions.withSession(record.id, token, true, action);
    if (result.isErr() && result.error.status === 401) {
      const marked = await rejected();
      if (marked.isErr())
        return Result.err(DiscordRest.error("mark rejected Discord login", 401, marked.error.message));
    }
    return result;
  };
  const ownMessage = async (channelId: string, messageId: string) => {
    const message = await rest.request("read own message", `/channels/${channelId}/messages/${messageId}`, Api.message);
    if (message.isErr()) return message;
    return message.value.author.id === record.user.id
      ? message
      : fail("change own message", "This message belongs to another account. Nothing was changed.");
  };
  /** Every voter for one answer, 100 per request. */
  const pollVoters = async (channelId: string, messageId: string, answerId: number) => {
    const voters: { id: string; username: string; globalName: string | null }[] = [];
    for (;;) {
      const query = new URLSearchParams({ limit: "100" });
      const last = voters.at(-1);
      if (last) query.set("after", last.id);
      const page = await rest.request(
        "list poll voters",
        `/channels/${channelId}/polls/${messageId}/answers/${answerId}`,
        z.object({ users: z.array(Api.user) }),
        { query },
      );
      if (page.isErr()) return page;
      voters.push(
        ...page.value.users.map((user) => ({ id: user.id, username: user.username, globalName: user.global_name ?? null })),
      );
      if (page.value.users.length < 100) return Result.ok(voters);
    }
  };
  const listGuilds = () => DiscordGuilds.list(rest);
  const interactions = DiscordInteractions.create(
    rest,
    sessions,
    { accountId: record.id, token, online: record.presenceOnWrite },
    rejected,
  );
  return {
    getAccount: async () =>
      Result.ok({
        ready: true,
        user: record.user,
        lastVerifiedAt: record.lastVerifiedAt,
        presenceOnWrite: record.presenceOnWrite,
      }),
    listGuilds,
    listGuildChannels: (guildId: string) =>
      rest.request("list guild channels", `/guilds/${guildId}/channels`, z.array(Api.channel)),
    listPrivateChannels: () => rest.request("list DMs", "/users/@me/channels", z.array(Api.channel)),
    openDm: (userId: string) =>
      write(() =>
        rest.request("open DM", "/users/@me/channels", Api.channel, { method: "POST", body: { recipient_id: userId } }),
      ),
    getUser: (userId: string) => rest.request("get user", `/users/${userId}`, Api.user),
    fetchMessages: (channelId: string, limit: number, before?: string, after?: string) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before) query.set("before", before);
      if (after) query.set("after", after);
      return rest.request("fetch messages", `/channels/${channelId}/messages`, z.array(Api.serializedMessage), {
        query,
      });
    },
    fetchMessage: (channelId: string, messageId: string) =>
      rest.request("fetch message", `/channels/${channelId}/messages/${messageId}`, Api.serializedMessage),
    searchMessages: async (channelId: string, input: MessageSearch) => {
      const channel = await rest.request("get search channel", `/channels/${channelId}`, Api.channel);
      if (channel.isErr()) return channel;
      const query = new URLSearchParams({
        channel_id: channelId,
        include_nsfw: String(input.includeNsfw ?? false),
        offset: String(input.offset ?? 0),
        limit: String(input.limit ?? 25),
        sort_by: "timestamp",
        sort_order: input.sortOrder ?? "desc",
      });
      if (input.content !== undefined) query.set("content", input.content);
      if (input.maxId !== undefined) query.set("max_id", input.maxId);
      if (input.minId !== undefined) query.set("min_id", input.minId);
      if (input.pinned !== undefined) query.set("pinned", String(input.pinned));
      for (const id of input.authorIds ?? []) query.append("author_id", id);
      for (const id of input.mentionIds ?? []) query.append("mentions", id);
      for (const value of input.has ?? []) query.append("has", value);
      const path = channel.value.guild_id
        ? `/guilds/${channel.value.guild_id}/messages/search`
        : `/channels/${channelId}/messages/search`;
      const result = await rest.request(
        "search messages",
        path,
        z.object({ total_results: z.number(), messages: z.array(z.array(Api.message)) }),
        { query },
      );
      if (result.isErr()) return result;
      const matches = result.value.messages.flat();
      return Result.ok({
        total: result.value.total_results,
        messages: [...new Map(matches.map((item) => [item.id, Api.serializeMessage(item)])).values()],
      });
    },
    sendMessage: (channelId: string, input: SendMessage) => {
      if (!input.content?.trim())
        return Promise.resolve(
          fail(
            "send message",
            "A message needs non-empty content. Local-file attachments are unavailable on this remote server.",
          ),
        );
      return write(() =>
        rest.request("send message", `/channels/${channelId}/messages`, Api.serializedMessage, {
          method: "POST",
          body: {
            content: input.content,
            allowed_mentions: input.allowMentions
              ? { parse: ["users", "roles", "everyone"], replied_user: true }
              : { parse: [], replied_user: false },
            ...(input.replyToMessageId
              ? {
                  message_reference: {
                    message_id: input.replyToMessageId,
                    channel_id: channelId,
                    fail_if_not_exists: true,
                  },
                }
              : {}),
            ...(input.silent ? { flags: 4096 } : {}),
          },
        }),
      );
    },
    createPoll: async (channelId: string, input: CreatePoll) => {
      const sent = await write(() =>
        rest.request("create poll", `/channels/${channelId}/messages`, Api.serializedMessage, {
          method: "POST",
          body: {
            ...(input.content?.trim() ? { content: input.content } : {}),
            allowed_mentions: { parse: [], replied_user: false },
            poll: DiscordPoll.request(input),
          },
        }),
      );
      if (sent.isErr() || sent.value.poll !== null) return sent;
      return fail(
        "create poll",
        `Discord saved message ${sent.value.id} without a poll. Check it in Discord (${sent.value.url}) and delete it before retrying.`,
      );
    },
    getPollResults: async (channelId: string, messageId: string, includeVoters: boolean) => {
      const found = await rest.request(
        "read poll",
        `/channels/${channelId}/messages/${messageId}`,
        Api.serializedMessage,
      );
      if (found.isErr()) return found;
      const { poll, url } = found.value;
      if (poll === null) return fail("read poll results", "This message has no poll. Check the message ID.");
      const answers = [];
      for (const answer of poll.answers) {
        if (!includeVoters) {
          answers.push({ ...answer, voters: null });
          continue;
        }
        const voters = await pollVoters(channelId, messageId, answer.answerId);
        if (voters.isErr()) return voters;
        answers.push({ ...answer, voters: voters.value });
      }
      return Result.ok({ messageId, url, ...poll, answers });
    },
    endPoll: async (channelId: string, messageId: string, confirm: boolean) => {
      const denied = confirmed(confirm, "end poll");
      if (denied) return denied;
      const own = await ownMessage(channelId, messageId);
      if (own.isErr()) return own;
      if (own.value.poll === undefined) return fail("end poll", "This message has no poll. Nothing was changed.");
      return write(() =>
        rest.request("end poll", `/channels/${channelId}/polls/${messageId}/expire`, Api.serializedMessage, {
          method: "POST",
        }),
      );
    },
    editOwnMessage: async (channelId: string, messageId: string, content: string) => {
      const own = await ownMessage(channelId, messageId);
      if (own.isErr()) return own;
      return write(() =>
        rest.request("edit own message", `/channels/${channelId}/messages/${messageId}`, Api.serializedMessage, {
          method: "PATCH",
          body: { content, allowed_mentions: { parse: [], replied_user: false } },
        }),
      );
    },
    deleteOwnMessage: async (channelId: string, messageId: string, confirm: boolean) => {
      const denied = confirmed(confirm, "delete own message");
      if (denied) return denied;
      const own = await ownMessage(channelId, messageId);
      if (own.isErr()) return own;
      return write(() =>
        rest.request(
          "delete own message",
          `/channels/${channelId}/messages/${messageId}`,
          z.null().transform(() => ({ deleted: true, channelId, messageId })),
          { method: "DELETE" },
        ),
      );
    },
    addReaction: (channelId: string, messageId: string, emoji: string) =>
      write(() =>
        rest.request(
          "add reaction",
          `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
          z.null().transform(() => ({ reacted: true, channelId, messageId, emoji })),
          { method: "PUT" },
        ),
      ),
    removeOwnReaction: (channelId: string, messageId: string, emoji: string) =>
      write(() =>
        rest.request(
          "remove own reaction",
          `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
          z.null().transform(() => ({ removed: true, channelId, messageId, emoji })),
          { method: "DELETE" },
        ),
      ),
    createThread: (channelId: string, messageId: string, name: string) =>
      write(() =>
        rest.request("create thread", `/channels/${channelId}/messages/${messageId}/threads`, Api.channel, {
          method: "POST",
          body: { name },
        }),
      ),
    updateThread: async (threadId: string, options: { name?: string; archived?: boolean; locked?: boolean }) => {
      const thread = await rest.request("get thread", `/channels/${threadId}`, Api.channel);
      if (thread.isErr()) return thread;
      if (![10, 11, 12].includes(thread.value.type))
        return fail("update thread", "The channel is not a thread. Nothing was changed.");
      return write(() =>
        rest.request("update thread", `/channels/${threadId}`, Api.channel, { method: "PATCH", body: options }),
      );
    },
    invokeSlashCommand: interactions.slash,
    clickButton: interactions.click,
    selectMenu: (channelId: string, messageId: string, customId: string, values: string[]) =>
      interactions.select(channelId, messageId, customId, values),
    joinGuild: (invite: string, confirm: boolean) => {
      const denied = confirmed(confirm, "join guild");
      if (denied) return Promise.resolve(denied);
      const code = invite
        .trim()
        .match(/^(?:https:\/\/(?:discord\.gg\/|discord\.com\/invite\/))?([A-Za-z0-9_-]+)\/?$/)?.[1];
      if (!code)
        return Promise.resolve(
          fail("join guild", "Use a Discord invite code or a discord.gg invite URL. Nothing was sent."),
        );
      return write(() =>
        rest.request(
          "join guild",
          `/invites/${code}`,
          z.object({ guild: Api.guild.optional(), channel: Api.channel.optional() }),
          { method: "POST", body: {} },
        ),
      );
    },
    leaveGuild: async (guildId: string, confirm: boolean) => {
      const denied = confirmed(confirm, "leave guild");
      if (denied) return denied;
      const guild = await rest.request("get guild", `/guilds/${guildId}`, Api.guild);
      if (guild.isErr()) return guild;
      if (guild.value.owner_id === record.user.id || guild.value.owner)
        return fail(
          "leave guild",
          "You own this guild. Transfer ownership in Discord before leaving. Nothing was changed.",
        );
      return write(() =>
        rest.request(
          "leave guild",
          `/users/@me/guilds/${guildId}`,
          z.null().transform(() => ({ left: true, guildId, name: guild.value.name })),
          { method: "DELETE" },
        ),
      );
    },
    getGuildLayout: () => DiscordGuildLayout.get(rest),
    replaceGuildLayout: (folders: GuildFolderInput[], confirm: boolean) => {
      const denied = confirmed(confirm, "replace guild layout");
      if (denied) return Promise.resolve(denied);
      return write(() => DiscordGuildLayout.replace(rest, folders, confirm));
    },
  } as const;
};
export type DiscordService = ReturnType<typeof create>;
export const DiscordService = { create } as const;
