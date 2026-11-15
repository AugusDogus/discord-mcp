import { randomBytes } from "node:crypto";
import { Result } from "better-result";
import { z } from "zod";
import { DiscordApiSchema } from "./api-schema";
import type { DiscordPresence } from "./presence";
import { DiscordRest, type DiscordApiError } from "./rest";
import { DiscordSlashCommand } from "./slash-command";

export type InteractionAccount = { readonly userId: string; readonly token: string; readonly online: boolean };
const component: z.ZodType<Component> = z.lazy(() =>
  z.object({
    type: z.number(),
    custom_id: z.string().optional(),
    disabled: z.boolean().optional(),
    min_values: z.number().optional(),
    max_values: z.number().optional(),
    options: z.array(z.object({ value: z.string() })).optional(),
    components: z.array(component).optional(),
  }),
);
type Component = {
  type: number;
  custom_id?: string;
  disabled?: boolean;
  min_values?: number;
  max_values?: number;
  options?: { value: string }[];
  components?: Component[];
};
const find = (items: Component[], id: string): Component | undefined => {
  for (const item of items) {
    if (item.custom_id === id) return item;
    const nested = find(item.components ?? [], id);
    if (nested) return nested;
  }
};
const create = (
  rest: DiscordRest,
  sessions: DiscordPresence,
  account: InteractionAccount,
  rejected: () => Promise<Result<unknown, { readonly message: string }>>,
) => {
  const send = async (body: Record<string, unknown>) => {
    const result = await sessions.withSession(account.userId, account.token, account.online, async (session) => {
      const nonce = (
        ((BigInt(Date.now()) - 1420070400000n) << 22n) |
        BigInt(randomBytes(3).readUIntBE(0, 3) & 0x3fffff)
      ).toString();
      const sent = await rest.request("submit interaction", "/interactions", z.null(), {
        method: "POST",
        body: { ...body, session_id: session.sessionId, nonce },
      });
      return sent.isErr()
        ? sent
        : Result.ok({
            submitted: true,
            nonce,
            message:
              "Discord accepted the interaction. Fetch messages to read its result; modals must be completed in Discord.",
          });
    });
    if (result.isErr() && result.error.status === 401) {
      const marked = await rejected();
      if (marked.isErr())
        return Result.err(DiscordRest.error("mark rejected interaction login", 401, marked.error.message));
    }
    return result;
  };
  const slash = async (channelId: string, applicationId: string, commandName: string, args: string[]) => {
    const channel = await rest.request("get interaction channel", `/channels/${channelId}`, DiscordApiSchema.channel);
    if (channel.isErr()) return channel;
    const index = z.object({ application_commands: z.array(DiscordSlashCommand.schema) });
    const scope = channel.value.guild_id ? `/guilds/${channel.value.guild_id}` : `/channels/${channelId}`;
    const commands = await rest.request("list application commands", `${scope}/application-command-index`, index);
    if (commands.isErr()) return commands;
    const name = commandName.trim().split(/\s+/)[0];
    let command = commands.value.application_commands.find(
      (item) => item.application_id === applicationId && item.name === name && item.type === 1,
    );
    if (!command) {
      const installed = await rest.request(
        "list installed application commands",
        "/users/@me/application-command-index",
        index,
      );
      if (installed.isErr()) return installed;
      command = installed.value.application_commands.find(
        (item) => item.application_id === applicationId && item.name === name && item.type === 1,
      );
    }
    if (!command)
      return Result.err(
        DiscordRest.error(
          "invoke slash command",
          null,
          "The application command was not found. Check its application ID and command name in Discord.",
        ),
      );
    const data = DiscordSlashCommand.build(command, commandName, args);
    if (data.isErr()) return data;
    return send({
      type: 2,
      application_id: applicationId,
      channel_id: channelId,
      ...(channel.value.guild_id ? { guild_id: channel.value.guild_id } : {}),
      data: { ...data.value, application_command: command },
    });
  };
  const componentAction = async (
    channelId: string,
    messageId: string,
    customId: string,
    values?: string[],
  ): Promise<Result<unknown, DiscordApiError>> => {
    const message = await rest.request(
      "read interaction message",
      `/channels/${channelId}/messages/${messageId}`,
      DiscordApiSchema.message,
    );
    if (message.isErr()) return message;
    const parsed = z.array(component).safeParse(message.value.components);
    const target = parsed.success ? find(parsed.data, customId) : undefined;
    if (
      !target ||
      target.disabled ||
      (values === undefined ? target.type !== 2 : ![3, 5, 6, 7, 8].includes(target.type))
    )
      return Result.err(
        DiscordRest.error(
          "use message component",
          null,
          "The requested component is unavailable or disabled. Fetch the message again and check its custom ID.",
        ),
      );
    if (
      values !== undefined &&
      (values.length < (target.min_values ?? 1) ||
        values.length > (target.max_values ?? 1) ||
        (target.type === 3 && values.some((value) => !target.options?.some((option) => option.value === value))))
    )
      return Result.err(
        DiscordRest.error(
          "select menu",
          null,
          "The menu values do not match its choices or selection limits. Nothing was sent.",
        ),
      );
    // REST message responses commonly omit guild_id, unlike gateway events.
    let guildId = message.value.guild_id;
    if (guildId === undefined) {
      const channel = await rest.request("get component channel", `/channels/${channelId}`, DiscordApiSchema.channel);
      if (channel.isErr()) return channel;
      guildId = channel.value.guild_id;
    }
    return send({
      type: 3,
      application_id: message.value.application_id ?? message.value.author.id,
      channel_id: channelId,
      message_id: messageId,
      ...(guildId ? { guild_id: guildId } : {}),
      message_flags: message.value.flags ?? 0,
      data: { component_type: target.type, custom_id: customId, ...(values === undefined ? {} : { values }) },
    });
  };
  return {
    slash,
    click: (channelId: string, messageId: string, customId: string) => componentAction(channelId, messageId, customId),
    select: componentAction,
  } as const;
};
export const DiscordInteractions = { create } as const;
