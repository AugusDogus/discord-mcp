import { z } from "zod";

const id = z.string().regex(/^\d+$/);
const user = z.object({
  id,
  username: z.string(),
  global_name: z.string().nullable().optional(),
  discriminator: z.string().optional(),
  avatar: z.string().nullable().optional(),
  bot: z.boolean().optional(),
});
const channel = z.object({
  id,
  type: z.number().int(),
  guild_id: id.optional(),
  name: z.string().nullable().optional(),
  position: z.number().optional(),
  parent_id: id.nullable().optional(),
  owner_id: id.optional(),
  last_message_id: id.nullable().optional(),
  recipients: z.array(user).optional(),
  thread_metadata: z.object({ archived: z.boolean(), locked: z.boolean().optional() }).optional(),
});
const guild = z.object({
  id,
  name: z.string(),
  description: z.string().nullable().optional(),
  owner_id: id.optional(),
  owner: z.boolean().optional(),
  icon: z.string().nullable().optional(),
  features: z.array(z.string()).optional(),
});
const message = z.object({
  id,
  channel_id: id,
  guild_id: id.optional(),
  content: z.string(),
  author: user,
  timestamp: z.iso.datetime({ offset: true }),
  edited_timestamp: z.string().nullable().optional(),
  application_id: id.optional(),
  flags: z.number().optional(),
  attachments: z
    .array(z.object({ id, filename: z.string(), content_type: z.string().optional(), size: z.number(), url: z.url() }))
    .default([]),
  reactions: z
    .array(
      z.object({
        emoji: z.object({ id: id.nullable().optional(), name: z.string().nullable() }),
        count: z.number(),
        me: z.boolean(),
      }),
    )
    .default([]),
  mentions: z.array(user).default([]),
  message_reference: z
    .object({ message_id: id.optional(), channel_id: id.optional(), guild_id: id.optional() })
    .optional(),
  components: z.array(z.unknown()).default([]),
});

const serializeMessage = (data: z.infer<typeof message>) => ({
  id: data.id,
  channelId: data.channel_id,
  guildId: data.guild_id ?? null,
  content: data.content,
  url: `https://discord.com/channels/${data.guild_id ?? "@me"}/${data.channel_id}/${data.id}`,
  author: {
    id: data.author.id,
    username: data.author.username,
    globalName: data.author.global_name ?? null,
    bot: data.author.bot ?? false,
  },
  createdAt: data.timestamp,
  editedAt: data.edited_timestamp ?? null,
  attachments: data.attachments.map((item) => ({
    id: item.id,
    name: item.filename,
    contentType: item.content_type ?? null,
    size: item.size,
    url: item.url,
  })),
  reactions: data.reactions.map((item) => ({
    emoji: item.emoji.id ? `${item.emoji.name}:${item.emoji.id}` : item.emoji.name,
    count: item.count,
    me: item.me,
  })),
  mentionedUserIds: data.mentions.map((item) => item.id),
  reference: data.message_reference
    ? {
        messageId: data.message_reference.message_id,
        channelId: data.message_reference.channel_id,
        guildId: data.message_reference.guild_id,
      }
    : null,
  components: data.components,
});
export const DiscordApiSchema = {
  id,
  user,
  channel,
  guild,
  message,
  serializedMessage: message.transform(serializeMessage),
  serializeMessage,
} as const;
