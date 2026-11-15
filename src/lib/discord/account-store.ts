import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";
import { discordAccount, type DiscordAccountStatus } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import { DataBox, type DataBoxAad, type Dek, ServerKey, VaultConfig, type VaultStorageError } from "@/lib/vault";
import { DiscordUser } from "./user";

/**
 * The `discord_account` row: the Discord token and profile sealed with the
 * user's DEK, which the server key opens (docs/security.md). The token only
 * leaves this module through `credentials`, for a request to Discord.
 */

export type DiscordAccountRecord = {
  readonly userId: string;
  readonly status: DiscordAccountStatus;
  readonly presenceOnWrite: boolean;
  readonly lastVerifiedAt: Date | null;
  readonly user: DiscordUser;
};

/** A logged-in account and its token. Never log or return the token. */
export type DiscordCredentials = { readonly record: DiscordAccountRecord; readonly token: string };

/** A database read or write failed. Earlier committed state is intact. */
export class DiscordAccountStorageError extends TaggedError("DiscordAccountStorageError")<{
  operation: string;
  userId: string;
  cause: unknown;
  message: string;
}> {}

/**
 * The row exists but cannot be opened: the server key is gone or changed
 * (KEY_PEPPER rotated), or the row was modified. Logging in again replaces it.
 */
export class DiscordAccountUnreadableError extends TaggedError("DiscordAccountUnreadableError")<{
  userId: string;
  reason: "no_key" | "key_mismatch" | "key_invalid" | "envelope";
  message: string;
}> {}

export type DiscordAccountReadError = DiscordAccountStorageError | DiscordAccountUnreadableError | VaultStorageError;

const TABLE = "discord_account";
const aad = (userId: string, column: "token" | "profile"): DataBoxAad => ({ userId, table: TABLE, rowKey: userId, column });

const storage = (operation: string, userId: string) => (cause: unknown) =>
  new DiscordAccountStorageError({
    operation,
    userId,
    cause,
    message: `discord-mcp could not ${operation} because the database did not respond. Nothing else was changed; try again in a moment.`,
  });

const unreadable = (userId: string, reason: DiscordAccountUnreadableError["reason"]) =>
  new DiscordAccountUnreadableError({
    userId,
    reason,
    message: "discord-mcp can no longer open the stored Discord login (the server key changed or the row was modified). Nothing was sent to Discord. Log in to Discord again from the dashboard.",
  });

/** The user's DEK, minting a new server key when there is none or it no longer opens. */
const keyForLogin = async (
  db: Database,
  config: VaultConfig,
  userId: string,
): Promise<Result<Dek, VaultStorageError>> => {
  const unlocked = await ServerKey.unlockWith(db, config, userId);
  if (unlocked.isOk() && unlocked.value !== null) return Result.ok(unlocked.value);
  if (unlocked.isErr() && unlocked.error._tag === "VaultStorageError") return Result.err(unlocked.error);
  return ServerKey.createWith(db, config, userId);
};

/** Stores a fresh login, replacing any earlier one. Keeps the presence setting. */
const saveWith = async (
  db: Database,
  config: VaultConfig,
  userId: string,
  login: { readonly token: string; readonly user: DiscordUser },
): Promise<Result<DiscordAccountRecord, DiscordAccountStorageError | VaultStorageError>> => {
  const dek = await keyForLogin(db, config, userId);
  if (dek.isErr()) return Result.err(dek.error);
  const values = {
    dekId: dek.value.id,
    tokenEnc: DataBox.seal(dek.value, login.token, aad(userId, "token")),
    profileEnc: DataBox.sealJson(dek.value, login.user, aad(userId, "profile")),
    status: "active" as const,
    lastVerifiedAt: new Date(config.now()),
  };
  const saved = await Result.tryPromise({
    try: async () => {
      const [row] = await db
        .insert(discordAccount)
        .values({ userId, ...values })
        .onConflictDoUpdate({ target: discordAccount.userId, set: values })
        .returning({ presenceOnWrite: discordAccount.presenceOnWrite });
      return row?.presenceOnWrite ?? false;
    },
    catch: storage("save the Discord login", userId),
  });
  if (saved.isErr()) return Result.err(saved.error);
  return Result.ok({ userId, status: "active", presenceOnWrite: saved.value, lastVerifiedAt: values.lastVerifiedAt, user: login.user });
};

const loadRow = (db: Database, userId: string) =>
  Result.tryPromise({
    try: async () => {
      const [row] = await db.select().from(discordAccount).where(eq(discordAccount.userId, userId)).limit(1);
      return row ?? null;
    },
    catch: storage("read the Discord login", userId),
  });

/** The account and its token, or null when the user never logged in (or logged out). */
const credentialsWith = async (
  db: Database,
  config: VaultConfig,
  userId: string,
): Promise<Result<DiscordCredentials | null, DiscordAccountReadError>> => {
  const row = await loadRow(db, userId);
  if (row.isErr()) return Result.err(row.error);
  if (row.value === null) return Result.ok(null);
  const unlocked = await ServerKey.unlockWith(db, config, userId);
  if (unlocked.isErr()) {
    return Result.err(unlocked.error._tag === "VaultStorageError" ? unlocked.error : unreadable(userId, "key_invalid"));
  }
  const dek = unlocked.value;
  if (dek === null) return Result.err(unreadable(userId, "no_key"));
  if (dek.id !== row.value.dekId) return Result.err(unreadable(userId, "key_mismatch"));
  const token = DataBox.open(dek, row.value.tokenEnc, aad(userId, "token"));
  const user = DataBox.openJson(dek, row.value.profileEnc, aad(userId, "profile"), DiscordUser.StoredSchema);
  if (token.isErr() || user.isErr()) return Result.err(unreadable(userId, "envelope"));
  return Result.ok({
    token: token.value,
    record: {
      userId,
      status: row.value.status,
      presenceOnWrite: row.value.presenceOnWrite,
      lastVerifiedAt: row.value.lastVerifiedAt,
      user: user.value,
    },
  });
};

/** Discord accepted the token: record when, and refresh the stored profile. */
const markVerifiedWith = async (
  db: Database,
  config: VaultConfig,
  userId: string,
  user: DiscordUser,
): Promise<Result<void, DiscordAccountStorageError | VaultStorageError>> => {
  const unlocked = await ServerKey.unlockWith(db, config, userId);
  if (unlocked.isErr() && unlocked.error._tag === "VaultStorageError") return Result.err(unlocked.error);
  const dek = unlocked.isOk() ? unlocked.value : null;
  return Result.tryPromise({
    try: async () => {
      await db
        .update(discordAccount)
        .set({
          lastVerifiedAt: new Date(config.now()),
          ...(dek === null ? {} : { profileEnc: DataBox.sealJson(dek, user, aad(userId, "profile")) }),
        })
        .where(eq(discordAccount.userId, userId));
    },
    catch: storage("record the Discord login check", userId),
  });
};

/** Discord answered 401: the user has to log in again. */
const markRejected = (db: Database, userId: string): Promise<Result<void, DiscordAccountStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db.update(discordAccount).set({ status: "rejected" }).where(eq(discordAccount.userId, userId));
    },
    catch: storage("mark the Discord login as signed out", userId),
  });

const setPresenceOnWrite = (
  db: Database,
  userId: string,
  enabled: boolean,
): Promise<Result<boolean, DiscordAccountStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const rows = await db
        .update(discordAccount)
        .set({ presenceOnWrite: enabled })
        .where(eq(discordAccount.userId, userId))
        .returning({ userId: discordAccount.userId });
      return rows.length > 0;
    },
    catch: storage("save the presence setting", userId),
  });

const remove = (db: Database, userId: string): Promise<Result<void, DiscordAccountStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db.delete(discordAccount).where(eq(discordAccount.userId, userId));
    },
    catch: storage("delete the Discord login", userId),
  });

export const DiscordAccountStore = {
  save: (db: Database, userId: string, login: { readonly token: string; readonly user: DiscordUser }) =>
    saveWith(db, VaultConfig.fromEnv(), userId, login),
  credentials: (db: Database, userId: string) => credentialsWith(db, VaultConfig.fromEnv(), userId),
  markVerified: (db: Database, userId: string, user: DiscordUser) => markVerifiedWith(db, VaultConfig.fromEnv(), userId, user),
  markRejected,
  setPresenceOnWrite,
  delete: remove,
  saveWith,
  credentialsWith,
  markVerifiedWith,
} as const;
