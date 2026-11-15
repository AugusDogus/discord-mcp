import { Result } from "better-result";
import { z } from "zod";
import type { DiscordAccountRecord, DiscordAccountReadError, DiscordCredentials } from "./account-store";
import { DiscordUser } from "./user";
import { DiscordRest } from "./rest";

export type AccountHealth =
  | { readonly kind: "login" }
  | {
      readonly kind: "connected";
      readonly account: DiscordAccountRecord;
      readonly health: "verified" | "unknown";
      readonly message?: string;
    };
export type AccountHealthDeps = {
  readonly credentials: (userId: string) => Promise<Result<DiscordCredentials | null, DiscordAccountReadError>>;
  readonly rest: (userId: string, token: string) => DiscordRest;
  readonly verified: (userId: string, user: DiscordUser) => Promise<Result<unknown, { readonly message: string }>>;
  readonly now: () => number;
};

const check = async (
  deps: AccountHealthDeps,
  userId: string,
): Promise<Result<AccountHealth, { readonly message: string }>> => {
  const loaded = await deps.credentials(userId);
  if (loaded.isErr())
    return loaded.error._tag === "DiscordAccountUnreadableError" ? Result.ok({ kind: "login" }) : loaded;
  if (loaded.value === null || loaded.value.record.status === "rejected") return Result.ok({ kind: "login" });
  const { record, token } = loaded.value;
  if (record.lastVerifiedAt !== null && deps.now() - record.lastVerifiedAt.getTime() < 60_000)
    return Result.ok({ kind: "connected", account: record, health: "verified" });
  const response = await deps.rest(userId, token).request("check the Discord login", "/users/@me", z.unknown());
  if (response.isErr())
    return response.error.status === 401
      ? Result.ok({ kind: "login" })
      : Result.ok({ kind: "connected", account: record, health: "unknown", message: response.error.message });
  const user = DiscordUser.fromApi(response.value);
  if (user === null)
    return Result.ok({
      kind: "connected",
      account: record,
      health: "unknown",
      message: "Discord returned an unreadable profile. Try reloading later.",
    });
  const saved = await deps.verified(userId, user);
  if (saved.isErr()) return Result.err(saved.error);
  return Result.ok({
    kind: "connected",
    account: { ...record, user, lastVerifiedAt: new Date(deps.now()) },
    health: "verified",
  });
};
export const DiscordAccountHealth = { check } as const;
