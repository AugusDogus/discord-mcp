/**
 * Demo database writes for ./record.ts, made with the app's own modules so
 * the server-rendered dashboard shows exactly what a real login leaves
 * behind. Reads DATABASE_URL and KEY_PEPPER from the environment (set by
 * record.ts to a throwaway database and key).
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { user } from "@/lib/db/auth-schema";
import { getDb } from "@/lib/db/client";
import { DiscordAccountStore } from "@/lib/discord/account-store";
import type { DiscordUser } from "@/lib/discord/user";

export const Seed = {
  /** The id of the user Tailscale sign-in created for `login`. */
  userId: async (login: string): Promise<string> => {
    const [row] = await getDb().select({ id: user.id }).from(user).where(eq(user.email, login)).limit(1);
    if (row === undefined) throw new Error(`demo seed: no user ${login}; did the Tailscale sign-in run?`);
    return row.id;
  },

  /**
   * What a verified login saves: the sealed token and profile. The token is
   * random and never sent anywhere (./server-preload.mjs blocks Discord).
   */
  logIn: async (userId: string, discordUser: DiscordUser): Promise<void> => {
    const saved = await DiscordAccountStore.save(getDb(), userId, {
      token: `demo.${randomBytes(24).toString("base64url")}`,
      user: discordUser,
    });
    if (saved.isErr()) throw new Error(`demo seed: DiscordAccountStore.save failed: ${saved.error.message}`);
  },
} as const;
