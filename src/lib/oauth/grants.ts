import { Result } from "better-result";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@/lib/db/client";
import { keySlot, oauthClient, oauthGrant } from "@/lib/db/vault-schema";
import { OAuthErrors, type OAuthStorageError } from "./errors";
import { McpScope } from "./scopes";

export type OAuthGrantRow = typeof oauthGrant.$inferSelect;

export type GrantRevocationReason =
  | "authorization_code_reuse"
  | "refresh_token_reuse"
  | "revoked_by_client"
  | "revoked_by_user"
  | "discord_account_logged_out";

/**
 * Why a grant cannot act: the Discord account it was bound to was logged out
 * (or it predates accounts and had none). Agents see this text.
 */
const ACCOUNT_LOGGED_OUT_MESSAGE =
  "The Discord account this connection used was logged out of discord-mcp, so the connection no longer works. Nothing was sent to Discord. Reconnect discord-mcp in your MCP client and pick a Discord account on the approval page.";

/** True when the grant stopped working because its Discord account is gone. */
const lostAccount = (grant: Pick<OAuthGrantRow, "discordAccountId" | "revokedAt" | "revokedReason">): boolean =>
  grant.revokedReason === "discord_account_logged_out" || (grant.revokedAt === null && grant.discordAccountId === null);

/** A connected client as the dashboard shows it. */
export type ActiveGrant = {
  readonly id: string;
  /** The stored Discord account the client acts as; null only for a grant whose account is gone. */
  readonly discordAccountId: string | null;
  readonly clientName: string;
  readonly scopes: readonly McpScope[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
};

const load = (db: Database, grantId: string): Promise<Result<OAuthGrantRow | null, OAuthStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const [row] = await db.select().from(oauthGrant).where(eq(oauthGrant.id, grantId)).limit(1);
      return row ?? null;
    },
    catch: (cause) => OAuthErrors.storage(`load grant ${grantId}`, cause),
  });

/**
 * Revokes a grant and every key slot (codes, refresh tokens) under it in one
 * batch. Access tokens die with it because
 * every request checks the grant. Revoking an already revoked grant keeps the
 * first reason and time.
 */
const revoke = (
  db: Database,
  grantId: string,
  reason: GrantRevocationReason,
  now: number,
): Promise<Result<void, OAuthStorageError>> =>
  Result.tryPromise({
    try: async () => {
      await db.batch([
        db
          .update(oauthGrant)
          .set({ revokedAt: now, revokedReason: reason })
          .where(and(eq(oauthGrant.id, grantId), isNull(oauthGrant.revokedAt))),
        db
          .update(keySlot)
          .set({ revokedAt: sql`coalesce(${keySlot.revokedAt}, ${now})` })
          .where(eq(keySlot.grantId, grantId)),
      ]);
    },
    catch: (cause) => OAuthErrors.storage(`revoke grant ${grantId}`, cause),
  });

/** Revokes `grantId` only if it belongs to `userId`. Ok(false) when there is no such grant. */
const revokeOwned = async (
  db: Database,
  userId: string,
  grantId: string,
  now: number,
): Promise<Result<boolean, OAuthStorageError>> => {
  const grant = await load(db, grantId);
  if (grant.isErr()) return Result.err(grant.error);
  if (!grant.value || grant.value.userId !== userId) return Result.ok(false);
  const revoked = await revoke(db, grantId, "revoked_by_user", now);
  return revoked.map(() => true);
};

const listActive = (db: Database, userId: string): Promise<Result<ActiveGrant[], OAuthStorageError>> =>
  Result.tryPromise({
    try: async () => {
      const rows = await db
        .select({
          id: oauthGrant.id,
          discordAccountId: oauthGrant.discordAccountId,
          clientName: oauthClient.clientName,
          scope: oauthGrant.scope,
          createdAt: oauthGrant.createdAt,
          lastUsedAt: oauthGrant.lastUsedAt,
        })
        .from(oauthGrant)
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthGrant.clientId))
        .where(and(eq(oauthGrant.userId, userId), isNull(oauthGrant.revokedAt)))
        .orderBy(desc(oauthGrant.createdAt));
      return rows.map((row) => ({
        id: row.id,
        discordAccountId: row.discordAccountId,
        clientName: row.clientName,
        scopes: McpScope.parse(row.scope).scopes,
        createdAt: new Date(row.createdAt),
        lastUsedAt: row.lastUsedAt === null ? null : new Date(row.lastUsedAt),
      }));
    },
    catch: (cause) => OAuthErrors.storage(`list grants of user ${userId}`, cause),
  });

export const OAuthGrants = {
  ACCOUNT_LOGGED_OUT_MESSAGE,
  lostAccount,
  load,
  revoke,
  revokeOwned,
  listActive,
} as const;
