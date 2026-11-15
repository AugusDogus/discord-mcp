import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
 * The Discord account a user logged in with (one per user). `token_enc` is
 * the Discord token and `profile_enc` the account's id, names and avatar,
 * both sealed with the user's DEK; `dek_id` names the DEK they were sealed
 * with. `status` is `rejected` once Discord answers 401 to the token: the
 * user has to log in again. `presence_on_write` is the dashboard setting
 * "Show me online when an agent sends or reacts".
 */
export const discordAccount = sqliteTable(
  "discord_account",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
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
  (table) => [check("discord_account_status_check", sql`${table.status} in ('active', 'rejected')`)],
);
