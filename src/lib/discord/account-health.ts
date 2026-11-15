import { Result } from "better-result";
import { z } from "zod";
import type { DiscordAccountKey, DiscordAccountRecord, DiscordAccountReadError, DiscordCredentials } from "./account-store";
import { DiscordUser } from "./user";
import { DiscordRest } from "./rest";

/**
 * One stored account's login state. `login` means the account has to be
 * logged in again from the dashboard: `account` is the stored record when
 * Discord rejected its token, and null when it is gone or cannot be opened.
 */
export type AccountHealth =
  | { readonly kind: "login"; readonly account: DiscordAccountRecord | null }
  | {
      readonly kind: "connected";
      readonly account: DiscordAccountRecord;
      readonly health: "verified" | "unknown";
      readonly message?: string;
    };
export type AccountHealthDeps = {
  readonly credentials: (key: DiscordAccountKey) => Promise<Result<DiscordCredentials | null, DiscordAccountReadError>>;
  readonly rest: (key: DiscordAccountKey, token: string) => DiscordRest;
  readonly verified: (key: DiscordAccountKey, user: DiscordUser) => Promise<Result<unknown, { readonly message: string }>>;
  readonly now: () => number;
};

const check = async (
  deps: AccountHealthDeps,
  key: DiscordAccountKey,
): Promise<Result<AccountHealth, { readonly message: string }>> => {
  const loaded = await deps.credentials(key);
  if (loaded.isErr())
    return loaded.error._tag === "DiscordAccountUnreadableError" ? Result.ok({ kind: "login", account: null }) : loaded;
  if (loaded.value === null) return Result.ok({ kind: "login", account: null });
  const { record, token } = loaded.value;
  if (record.status === "rejected") return Result.ok({ kind: "login", account: record });
  if (record.lastVerifiedAt !== null && deps.now() - record.lastVerifiedAt.getTime() < 60_000)
    return Result.ok({ kind: "connected", account: record, health: "verified" });
  const response = await deps.rest(key, token).request("check the Discord login", "/users/@me", z.unknown());
  if (response.isErr())
    return response.error.status === 401
      ? Result.ok({ kind: "login", account: { ...record, status: "rejected" } })
      : Result.ok({ kind: "connected", account: record, health: "unknown", message: response.error.message });
  const user = DiscordUser.fromApi(response.value);
  if (user === null)
    return Result.ok({
      kind: "connected",
      account: record,
      health: "unknown",
      message: "Discord returned an unreadable profile. Try reloading later.",
    });
  const saved = await deps.verified(key, user);
  if (saved.isErr()) return Result.err(saved.error);
  return Result.ok({
    kind: "connected",
    account: { ...record, user, lastVerifiedAt: new Date(deps.now()) },
    health: "verified",
  });
};
export const DiscordAccountHealth = { check } as const;
