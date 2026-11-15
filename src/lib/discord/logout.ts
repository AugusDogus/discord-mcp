import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { discordAccount } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import { keySlot, oauthGrant, userKey } from "@/lib/db/vault-schema";
import type { DiscordAccountReadError, DiscordCredentials } from "./account-store";
import type { DiscordRest } from "./rest";

export class DiscordLogoutError extends TaggedError("DiscordLogoutError")<{ status: 409 | 503; message: string }> {}
export type DiscordLogoutDeps = {
  readonly db: Database;
  readonly credentials: (userId: string) => Promise<Result<DiscordCredentials | null, DiscordAccountReadError>>;
  readonly rest: (userId: string, token: string) => DiscordRest;
  readonly stop: (userId: string) => void;
};

/** Caller holds the account lease. A remote failure preserves the local login for retry. */
const run = async (deps: DiscordLogoutDeps, userId: string): Promise<Result<void, DiscordLogoutError>> => {
  deps.stop(userId);
  const loaded = await deps.credentials(userId);
  if (loaded.isErr())
    return Result.err(
      new DiscordLogoutError({
        status: 409,
        message: `${loaded.error.message} The stored login, key and agent grants were kept.`,
      }),
    );
  if (loaded.value !== null) {
    const response = await deps
      .rest(userId, loaded.value.token)
      .request("log out of Discord", "/auth/logout", z.null(), {
        method: "POST",
        body: { provider: null, voip_provider: null },
      });
    if (response.isErr() && response.error.status !== 401)
      return Result.err(
        new DiscordLogoutError({
          status: 503,
          message: `${response.error.message} The local login, key and agent grants were kept. Try logging out again.`,
        }),
      );
  }
  return Result.tryPromise({
    try: async () => {
      await deps.db.batch([
        deps.db.delete(discordAccount).where(eq(discordAccount.userId, userId)),
        deps.db.delete(keySlot).where(eq(keySlot.userId, userId)),
        deps.db.delete(oauthGrant).where(eq(oauthGrant.userId, userId)),
        deps.db.delete(userKey).where(eq(userKey.userId, userId)),
      ]);
    },
    catch: () =>
      new DiscordLogoutError({
        status: 503,
        message:
          "Discord was signed out, but local cleanup failed. The local login, key and grants remain together; try Log out again to remove them.",
      }),
  });
};
export const DiscordLogout = { run } as const;
