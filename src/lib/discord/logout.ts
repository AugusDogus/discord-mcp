import { Result, TaggedError } from "better-result";
import { and, eq, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { discordAccount } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import { oauthGrant, userKey } from "@/lib/db/vault-schema";
import type { DiscordAccountKey, DiscordAccountReadError, DiscordCredentials } from "./account-store";
import type { DiscordRest } from "./rest";

export class DiscordLogoutError extends TaggedError("DiscordLogoutError")<{ status: 503; message: string }> {}
export type DiscordLogoutDeps = {
  readonly db: Database;
  readonly credentials: (key: DiscordAccountKey) => Promise<Result<DiscordCredentials | null, DiscordAccountReadError>>;
  readonly rest: (key: DiscordAccountKey, token: string) => DiscordRest;
  readonly stop: (key: DiscordAccountKey) => void;
  readonly now: () => number;
};

/**
 * Logs one stored account out of Discord, then removes its row and revokes
 * the agent grants bound to it, in one batch. Other accounts and their grants
 * are untouched; the user's server key goes with their last account. A row
 * the server key no longer opens is removed locally (its token cannot be read
 * to sign it out). Caller holds the account lease. A remote failure preserves
 * the local login for retry.
 */
const run = async (deps: DiscordLogoutDeps, key: DiscordAccountKey): Promise<Result<void, DiscordLogoutError>> => {
  deps.stop(key);
  const loaded = await deps.credentials(key);
  if (loaded.isErr() && loaded.error._tag !== "DiscordAccountUnreadableError")
    return Result.err(
      new DiscordLogoutError({
        status: 503,
        message: `${loaded.error.message} The stored login and its agent grants were kept.`,
      }),
    );
  if (loaded.isOk() && loaded.value !== null) {
    const response = await deps
      .rest(key, loaded.value.token)
      .request("log out of Discord", "/auth/logout", z.null(), {
        method: "POST",
        body: { provider: null, voip_provider: null },
      });
    if (response.isErr() && response.error.status !== 401)
      return Result.err(
        new DiscordLogoutError({
          status: 503,
          message: `${response.error.message} The local login and its agent grants were kept. Try logging out again.`,
        }),
      );
  }
  const now = deps.now();
  const { db } = deps;
  return Result.tryPromise({
    try: async () => {
      // Revoking the grant stops its codes, refresh tokens and access tokens:
      // each is checked against a live grant, which then reports why.
      await db.batch([
        db
          .update(oauthGrant)
          .set({
            revokedAt: sql`coalesce(${oauthGrant.revokedAt}, ${now})`,
            revokedReason: sql`coalesce(${oauthGrant.revokedReason}, 'discord_account_logged_out')`,
          })
          .where(and(eq(oauthGrant.userId, key.userId), eq(oauthGrant.discordAccountId, key.accountId))),
        db.delete(discordAccount).where(and(eq(discordAccount.id, key.accountId), eq(discordAccount.userId, key.userId))),
        db
          .delete(userKey)
          .where(
            and(
              eq(userKey.userId, key.userId),
              notExists(db.select({ id: discordAccount.id }).from(discordAccount).where(eq(discordAccount.userId, key.userId))),
            ),
          ),
      ]);
    },
    catch: () =>
      new DiscordLogoutError({
        status: 503,
        message:
          "Discord was signed out, but local cleanup failed. The local login and its agent grants remain together; try Log out again to remove them.",
      }),
  });
};
export const DiscordLogout = { run } as const;
