import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

/**
 * App tables. `*_at` columns are `timestamp_ms` (Date in TS, integer ms in
 * SQL). `*_enc` columns are DataBox envelopes sealed with the user's DEK
 * (src/lib/vault/data-box.ts); parse and validate them at the read boundary.
 */

const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const DISCORD_ACCOUNT_STATUSES = ["active", "rejected"] as const;
export type DiscordAccountStatus = (typeof DISCORD_ACCOUNT_STATUSES)[number];

/**
 * A Discord account a user logged in with; a user can have several, each
 * used by the agent connections bound to it (`oauth_grant.discord_account_id`).
 * `token_enc` is the Discord token and `profile_enc` the account's id, names
 * and avatar, both sealed with the user's DEK with `id` as the row key;
 * `dek_id` names the DEK they were sealed with. `discord_user_id` is Discord's
 * id for the account, unique per user, so logging in to the same account again
 * refreshes its row. It is null only for an account stored before accounts had
 * their own id (its `id` is the user's id) until its next login. `status` is
 * `rejected` once Discord answers 401 to the token: the user has to log in
 * again. `presence_on_write` is the dashboard setting "Show me online when an
 * agent sends or reacts".
 */
export const discordAccount = sqliteTable(
  "discord_account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id"),
    dekId: text("dek_id").notNull(),
    tokenEnc: text("token_enc").notNull(),
    profileEnc: text("profile_enc").notNull(),
    status: text("status", { enum: DISCORD_ACCOUNT_STATUSES }).notNull(),
    presenceOnWrite: integer("presence_on_write", { mode: "boolean" }).default(false).notNull(),
    /** Last time Discord accepted the token (a successful REST call). */
    lastVerifiedAt: integer("last_verified_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).default(nowMs).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(nowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("discord_account_user_discord_user_unique").on(table.userId, table.discordUserId),
    check("discord_account_status_check", sql`${table.status} in ('active', 'rejected')`),
  ],
);
