import { Result, TaggedError } from "better-result";
import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { discordAccount, type DiscordAccountStatus } from "@/lib/db/app-schema";
import type { Database } from "@/lib/db/client";
import { Base64Url, DataBox, type DataBoxAad, type Dek, ServerKey, VaultConfig, type VaultStorageError } from "@/lib/vault";
import { DiscordUser } from "./user";

/**
 * The `discord_account` rows: each Discord account a user logged in with, its
 * token and profile sealed with the user's DEK, which the server key opens
 * (docs/security.md). The token only leaves this module through
 * `credentials`, for a request to Discord.
 */

/** Names one stored account of one signed-in user. Every read and write checks both. */
export type DiscordAccountKey = { readonly userId: string; readonly accountId: string };

export type DiscordAccountRecord = {
  readonly id: string;
  readonly userId: string;
  readonly status: DiscordAccountStatus;
  readonly presenceOnWrite: boolean;
  readonly lastVerifiedAt: Date | null;
  readonly user: DiscordUser;
};

/** A logged-in account and its token. Never log or return the token. */
export type DiscordCredentials = { readonly record: DiscordAccountRecord; readonly token: string };

/** One of a user's stored accounts as the dashboard and consent page list it (no token). */
export type DiscordAccountEntry =
  | { readonly kind: "readable"; readonly record: DiscordAccountRecord }
  | { readonly kind: "unreadable"; readonly id: string; readonly error: DiscordAccountUnreadableError };

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
  accountId: string;
  reason: "no_key" | "key_mismatch" | "key_invalid" | "envelope";
  message: string;
}> {}

export type DiscordAccountReadError = DiscordAccountStorageError | DiscordAccountUnreadableError | VaultStorageError;

type Row = typeof discordAccount.$inferSelect;

const TABLE = "discord_account";
const aad = (userId: string, accountId: string, column: "token" | "profile"): DataBoxAad => ({
  userId,
  table: TABLE,
  rowKey: accountId,
  column,
});

const storage = (operation: string, userId: string) => (cause: unknown) =>
  new DiscordAccountStorageError({
    operation,
    userId,
    cause,
    message: `discord-mcp could not ${operation} because the database did not respond. Nothing else was changed; try again in a moment.`,
  });

const unreadable = (userId: string, accountId: string, reason: DiscordAccountUnreadableError["reason"]) =>
  new DiscordAccountUnreadableError({
    userId,
    accountId,
    reason,
    message: "discord-mcp can no longer open this stored Discord login (the server key changed or the row was modified). Nothing was sent to Discord. Log in to this Discord account again from the dashboard.",
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

type ReadKey = { readonly kind: "open"; readonly dek: Dek } | { readonly kind: "missing"; readonly reason: "no_key" | "key_invalid" };

/** The user's DEK for reading rows, or why there is none that opens. */
const keyForRead = async (db: Database, config: VaultConfig, userId: string): Promise<Result<ReadKey, VaultStorageError>> => {
  const unlocked = await ServerKey.unlockWith(db, config, userId);
  if (unlocked.isErr())
    return unlocked.error._tag === "VaultStorageError" ? Result.err(unlocked.error) : Result.ok({ kind: "missing", reason: "key_invalid" });
  return Result.ok(unlocked.value === null ? { kind: "missing", reason: "no_key" } : { kind: "open", dek: unlocked.value });
};

const openWith = (key: ReadKey, row: Row): Result<DiscordCredentials, DiscordAccountUnreadableError> =>
  key.kind === "open" ? openRow(key.dek, row) : Result.err(unreadable(row.userId, row.id, key.reason));

const openRow = (dek: Dek, row: Row): Result<DiscordCredentials, DiscordAccountUnreadableError> => {
  if (dek.id !== row.dekId) return Result.err(unreadable(row.userId, row.id, "key_mismatch"));
  const token = DataBox.open(dek, row.tokenEnc, aad(row.userId, row.id, "token"));
  const user = DataBox.openJson(dek, row.profileEnc, aad(row.userId, row.id, "profile"), DiscordUser.StoredSchema);
  if (token.isErr() || user.isErr()) return Result.err(unreadable(row.userId, row.id, "envelope"));
  return Result.ok({
    token: token.value,
    record: {
      id: row.id,
      userId: row.userId,
      status: row.status,
      presenceOnWrite: row.presenceOnWrite,
      lastVerifiedAt: row.lastVerifiedAt,
      user: user.value,
    },
  });
};

const loadRows = (db: Database, userId: string) =>
  Result.tryPromise({
    try: () => db.select().from(discordAccount).where(eq(discordAccount.userId, userId)).orderBy(asc(discordAccount.createdAt), asc(discordAccount.id)),
    catch: storage("read the Discord logins", userId),
  });

/**
 * The row this login refreshes: the user's row for the same Discord account,
 * including one stored before rows recorded their Discord user id.
 */
const existingFor = (dek: Dek, rows: readonly Row[], discordUserId: string): Row | null =>
  rows.find((row) => row.discordUserId === discordUserId) ??
  rows.find((row) => row.discordUserId === null && openRow(dek, row).match({ ok: (opened) => opened.record.user.id === discordUserId, err: () => false })) ??
  null;

/**
 * Stores a fresh login. Logging in to an account the user already stored
 * refreshes that row (token, profile, status) and keeps its id, presence
 * setting and agent grants; another account gets a new row.
 */
const saveWith = async (
  db: Database,
  config: VaultConfig,
  userId: string,
  login: { readonly token: string; readonly user: DiscordUser },
): Promise<Result<DiscordAccountRecord, DiscordAccountStorageError | VaultStorageError>> => {
  const dek = await keyForLogin(db, config, userId);
  if (dek.isErr()) return Result.err(dek.error);
  const rows = await loadRows(db, userId);
  if (rows.isErr()) return Result.err(rows.error);
  const existing = existingFor(dek.value, rows.value, login.user.id);
  const id = existing?.id ?? Base64Url.encode(randomBytes(16));
  const values = {
    discordUserId: login.user.id,
    dekId: dek.value.id,
    tokenEnc: DataBox.seal(dek.value, login.token, aad(userId, id, "token")),
    profileEnc: DataBox.sealJson(dek.value, login.user, aad(userId, id, "profile")),
    status: "active" as const,
    lastVerifiedAt: new Date(config.now()),
  };
  const saved = await Result.tryPromise({
    try: async () => {
      if (existing === null) {
        await db.insert(discordAccount).values({ id, userId, ...values });
        return false;
      }
      const [row] = await db
        .update(discordAccount)
        .set(values)
        .where(and(eq(discordAccount.id, id), eq(discordAccount.userId, userId)))
        .returning({ presenceOnWrite: discordAccount.presenceOnWrite });
      return row?.presenceOnWrite ?? false;
    },
    catch: storage("save the Discord login", userId),
  });
  if (saved.isErr()) return Result.err(saved.error);
  return Result.ok({ id, userId, status: "active", presenceOnWrite: saved.value, lastVerifiedAt: values.lastVerifiedAt, user: login.user });
};

/** Every stored account of the user, oldest first, without tokens. */
const listWith = async (
  db: Database,
  config: VaultConfig,
  userId: string,
): Promise<Result<DiscordAccountEntry[], DiscordAccountStorageError | VaultStorageError>> => {
  const rows = await loadRows(db, userId);
  if (rows.isErr()) return Result.err(rows.error);
  if (rows.value.length === 0) return Result.ok([]);
  const key = await keyForRead(db, config, userId);
  if (key.isErr()) return Result.err(key.error);
  const readKey = key.value;
  return Result.ok(
    rows.value.map((row): DiscordAccountEntry => {
      const opened = openWith(readKey, row);
      return opened.isOk()
        ? { kind: "readable", record: opened.value.record }
        : { kind: "unreadable", id: row.id, error: opened.error };
    }),
  );
};

/** The account and its token, or null when the user has no such account (never logged in, or logged out). */
const credentialsWith = async (
  db: Database,
  config: VaultConfig,
  key: DiscordAccountKey,
): Promise<Result<DiscordCredentials | null, DiscordAccountReadError>> => {
  const row = await Result.tryPromise({
    try: async () => {
      const [found] = await db
        .select()
        .from(discordAccount)
        .where(and(eq(discordAccount.id, key.accountId), eq(discordAccount.userId, key.userId)))
        .limit(1);
      return found ?? null;
    },
    catch: storage("read the Discord login", key.userId),
  });
  if (row.isErr()) return Result.err(row.error);
  if (row.value === null) return Result.ok(null);
  const readKey = await keyForRead(db, config, key.userId);
  if (readKey.isErr()) return Result.err(readKey.error);
  return openWith(readKey.value, row.value);
};

/** Discord accepted the token: record when, refresh the stored profile and fill in its Discord user id. */
const markVerifiedWith = async (
  db: Database,
  config: VaultConfig,
  key: DiscordAccountKey,
  user: DiscordUser,
): Promise<Result<void, DiscordAccountStorageError | VaultStorageError>> => {
  const unlocked = await ServerKey.unlockWith(db, config, key.userId);
  if (unlocked.isErr() && unlocked.error._tag === "VaultStorageError") return Result.err(unlocked.error);
  const dek = unlocked.isOk() ? unlocked.value : null;
  return Result.tryPromise({
    try: async () => {
      await db
        .update(discordAccount)
        .set({
          lastVerifiedAt: new Date(config.now()),
          discordUserId: user.id,
          ...(dek === null ? {} : { profileEnc: DataBox.sealJson(dek, user, aad(key.userId, key.accountId, "profile")) }),
        })
        .where(and(eq(discordAccount.id, key.accountId), eq(discordAccount.userId, key.userId)));
    },
    catch: storage("record the Discord login check", key.userId),
  });
};

/** Discord answered 401: the user has to log in to this account again. */
const markRejected = (db: Database, key: DiscordAccountKey): Promise<Result<void, DiscordAccountStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db
        .update(discordAccount)
        .set({ status: "rejected" })
        .where(and(eq(discordAccount.id, key.accountId), eq(discordAccount.userId, key.userId)));
    },
    catch: storage("mark the Discord login as signed out", key.userId),
  });

/** Ok(false) when the user has no such account. */
const setPresenceOnWrite = (
  db: Database,
  key: DiscordAccountKey,
  enabled: boolean,
): Promise<Result<boolean, DiscordAccountStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const rows = await db
        .update(discordAccount)
        .set({ presenceOnWrite: enabled })
        .where(and(eq(discordAccount.id, key.accountId), eq(discordAccount.userId, key.userId)))
        .returning({ id: discordAccount.id });
      return rows.length > 0;
    },
    catch: storage("save the presence setting", key.userId),
  });

export const DiscordAccountStore = {
  save: (db: Database, userId: string, login: { readonly token: string; readonly user: DiscordUser }) =>
    saveWith(db, VaultConfig.fromEnv(), userId, login),
  list: (db: Database, userId: string) => listWith(db, VaultConfig.fromEnv(), userId),
  credentials: (db: Database, key: DiscordAccountKey) => credentialsWith(db, VaultConfig.fromEnv(), key),
  markVerified: (db: Database, key: DiscordAccountKey, user: DiscordUser) => markVerifiedWith(db, VaultConfig.fromEnv(), key, user),
  markRejected,
  setPresenceOnWrite,
  saveWith,
  listWith,
  credentialsWith,
  markVerifiedWith,
} as const;
