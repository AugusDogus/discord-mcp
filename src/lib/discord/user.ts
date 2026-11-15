import { z } from "zod";

/** The logged-in Discord account as discord-mcp stores and shows it. */
export type DiscordUser = {
  readonly id: string;
  readonly username: string;
  readonly globalName: string | null;
  /** "0" for accounts on the new username system. */
  readonly discriminator: string;
  /** Avatar hash, or null for Discord's default avatar. */
  readonly avatar: string | null;
};

const snowflake = z.string().regex(/^\d{1,20}$/);

/** GET /users/@me (only the fields discord-mcp keeps). */
const ApiSchema = z.object({
  id: snowflake,
  username: z.string().min(1),
  global_name: z.string().nullable().optional(),
  discriminator: z.string().default("0"),
  avatar: z.string().nullable().optional(),
});

/** The stored JSON form (DataBox `profile_enc`). */
const StoredSchema = z.object({
  id: snowflake,
  username: z.string(),
  globalName: z.string().nullable(),
  discriminator: z.string(),
  avatar: z.string().nullable(),
});

const fromApi = (value: unknown): DiscordUser | null => {
  const parsed = ApiSchema.safeParse(value);
  if (!parsed.success) return null;
  const { id, username, global_name, discriminator, avatar } = parsed.data;
  return { id, username, globalName: global_name ?? null, discriminator, avatar: avatar ?? null };
};

/**
 * The remote-auth `encrypted_user_payload`, decrypted:
 * `id:discriminator:avatarHash:username`. Usernames cannot contain ":", but
 * the rest is joined back in case an old one does.
 */
const fromRemoteAuthPayload = (payload: string): DiscordUser | null => {
  const [id, discriminator, avatar, ...rest] = payload.split(":");
  const username = rest.join(":");
  if (id === undefined || !snowflake.safeParse(id).success || discriminator === undefined || username === "") return null;
  return {
    id,
    username,
    globalName: null,
    discriminator,
    avatar: avatar === undefined || avatar === "" || avatar === "0" ? null : avatar,
  };
};

const CDN = "https://cdn.discordapp.com";

/** The avatar image URL, or the default avatar Discord shows for this account. */
const avatarUrl = (user: DiscordUser, size = 128): string => {
  if (user.avatar !== null) {
    const extension = user.avatar.startsWith("a_") ? "gif" : "png";
    return `${CDN}/avatars/${user.id}/${encodeURIComponent(user.avatar)}.${extension}?size=${size}`;
  }
  const legacy = Number.parseInt(user.discriminator, 10);
  const index = Number.isFinite(legacy) && legacy !== 0 ? legacy % 5 : Number((BigInt(user.id) >> 22n) % 6n);
  return `${CDN}/embed/avatars/${index}.png`;
};

/** The name Discord shows: display name, else username. */
const displayName = (user: DiscordUser): string => user.globalName ?? user.username;

/** `@username`, or `username#1234` for legacy accounts. */
const handle = (user: DiscordUser): string =>
  user.discriminator === "0" || user.discriminator === "" ? `@${user.username}` : `${user.username}#${user.discriminator}`;

export const DiscordUser = {
  fromApi,
  fromRemoteAuthPayload,
  StoredSchema,
  avatarUrl,
  displayName,
  handle,
} as const;
