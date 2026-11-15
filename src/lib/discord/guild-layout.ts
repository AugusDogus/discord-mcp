import { randomBytes } from "node:crypto";
import { Result } from "better-result";
import { PreloadedUserSettings } from "discord-protos";
import { z } from "zod";
import { DiscordGuilds } from "./guilds";
import { DiscordRest } from "./rest";

export type GuildFolderInput = {
  readonly id?: string;
  readonly name?: string;
  readonly color?: number;
  readonly guildIds: string[];
};
const responseSchema = z.object({ settings: z.string(), out_of_date: z.boolean().optional() });
const failure = (message: string) => DiscordRest.error("update guild layout", null, message);
const decode = (encoded: string) =>
  Result.try({
    try: () => {
      const settings = PreloadedUserSettings.fromBase64(encoded);
      return {
        dataVersion: settings.versions?.dataVersion ?? 0,
        folders: (settings.guildFolders?.folders ?? []).map((folder) => ({
          id: folder.id?.value.toString() ?? null,
          name: folder.name?.value ?? null,
          color: folder.color ? Number(folder.color.value) : null,
          guildIds: folder.guildIds.map(String),
        })),
      };
    },
    catch: () => failure("Discord returned unreadable guild folders. Nothing was changed. Try again later."),
  });
const get = async (rest: DiscordRest) => {
  const response = await rest.request("read guild layout", "/users/@me/settings-proto/1", responseSchema);
  return response.isErr() ? Result.err(response.error) : decode(response.value.settings);
};
const validate = (folders: readonly GuildFolderInput[], known: ReadonlySet<string>) => {
  const seen = new Set<string>();
  const folderIds = new Set<string>();
  for (const folder of folders) {
    if (folder.guildIds.length === 0) return failure("Guild folders cannot be empty. Nothing was changed.");
    if (folder.id !== undefined) {
      if (folderIds.has(folder.id)) return failure("Folder IDs must be unique. Nothing was changed.");
      folderIds.add(folder.id);
    }
    for (const id of folder.guildIds) {
      if (!known.has(id)) return failure(`Guild ${id} is not available to this account. Nothing was changed.`);
      if (seen.has(id)) return failure(`Guild ${id} appears more than once. Nothing was changed.`);
      seen.add(id);
    }
  }
  if (seen.size !== known.size) return failure("Include every current guild exactly once. Nothing was changed.");
  return null;
};
const replace = async (rest: DiscordRest, folders: readonly GuildFolderInput[], confirmed: boolean) => {
  if (!confirmed)
    return Result.err(failure("Set confirm to true after reviewing the complete new layout. Nothing was changed."));
  const guilds = await DiscordGuilds.list(rest);
  if (guilds.isErr()) return Result.err(guilds.error);
  const invalid = validate(folders, new Set(guilds.value.map((guild) => guild.id)));
  if (invalid) return Result.err(invalid);
  const current = await get(rest);
  if (current.isErr()) return Result.err(current.error);
  const encoded = Result.try({
    try: () =>
      PreloadedUserSettings.toBase64(
        PreloadedUserSettings.create({
          guildFolders: {
            folders: folders.map((folder) => {
              const id =
                folder.id ??
                (folder.guildIds.length > 1 || folder.name !== undefined || folder.color !== undefined
                  ? BigInt.asUintN(63, BigInt(`0x${randomBytes(8).toString("hex")}`)).toString()
                  : undefined);
              return {
                guildIds: folder.guildIds.map(BigInt),
                ...(id === undefined ? {} : { id: { value: BigInt(id) } }),
                ...(folder.name === undefined ? {} : { name: { value: folder.name } }),
                ...(folder.color === undefined ? {} : { color: { value: BigInt(folder.color) } }),
              };
            }),
            guildPositions: folders.flatMap((folder) => folder.guildIds).map(BigInt),
          },
        }),
      ),
    catch: () => failure("The guild layout could not be encoded. Check the folder and guild IDs. Nothing was changed."),
  });
  if (encoded.isErr()) return Result.err(encoded.error);
  const updated = await rest.request("replace guild layout", "/users/@me/settings-proto/1", responseSchema, {
    method: "PATCH",
    body: { settings: encoded.value, required_data_version: current.value.dataVersion },
  });
  if (updated.isErr()) return Result.err(updated.error);
  if (updated.value.out_of_date)
    return Result.err(failure("The layout changed in another client. Read it again before replacing it."));
  return get(rest);
};
export const DiscordGuildLayout = { get, replace, validate } as const;
