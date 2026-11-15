import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import { z } from "zod";
import { createDatabase, type Database } from "@/lib/db/client";
import { DiscordAccountStore } from "@/lib/discord/account-store";
import type { DiscordUser } from "@/lib/discord/user";
import { DataBox, ServerKey } from "@/lib/vault";
import { KeySlot, SlotCredential } from "@/lib/vault/key-slot";
import { VaultTesting } from "@/lib/vault/testing";

/**
 * Upgrading from one Discord account per user (0000_init) keeps the stored
 * account, its sealed token and settings, and binds its existing agent grants
 * to it.
 */

const migrationsFolder = resolve(import.meta.dir, "../../../drizzle");
const ONE_ACCOUNT_PER_USER = "0000_init";

const JournalSchema = z.object({
  version: z.string(),
  dialect: z.string(),
  entries: z.array(z.object({ idx: z.number(), tag: z.string() }).loose()),
});

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "discord-mcp-migrations-"));
  db = createDatabase({ url: `file:${join(dir, "test.db")}` });
});
afterEach(async () => {
  db.$client.close();
  await rm(dir, { recursive: true, force: true });
});

/** A copy of the migrations folder that stops at `lastTag`. */
const migrationsUpTo = async (lastTag: string): Promise<string> => {
  const folder = join(dir, "drizzle-old");
  await cp(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JournalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")));
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  expect(last).toBeGreaterThanOrEqual(0);
  await writeFile(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, last + 1) }));
  return folder;
};

const profile: DiscordUser = { id: "123", username: "test-user", globalName: "Test User", discriminator: "0", avatar: null };

describe("upgrade to several Discord accounts per user", () => {
  test("the existing account keeps its token and settings, and its grants are bound to it", async () => {
    await migrate(db, { migrationsFolder: await migrationsUpTo(ONE_ACCOUNT_PER_USER) });
    const vault = VaultTesting.vaultConfig();
    const userId = await VaultTesting.createUser(db);
    const withoutAccount = await VaultTesting.createUser(db);
    const dek = (await ServerKey.createWith(db, vault, userId)).unwrap();
    // Sealed exactly as the one-account store did: the row key was the user id.
    const aad = (column: "token" | "profile") => ({ userId, table: "discord_account", rowKey: userId, column });
    const exec = (sql: string, args: (string | number | null)[]) => db.$client.execute({ sql, args });
    await exec(
      "insert into discord_account (user_id, dek_id, token_enc, profile_enc, status, presence_on_write, last_verified_at) values (?, ?, ?, ?, ?, ?, ?)",
      [userId, dek.id, DataBox.seal(dek, "test-token-not-real", aad("token")), DataBox.sealJson(dek, profile, aad("profile")), "active", 1, 1_000],
    );
    await exec(
      "insert into oauth_client (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, scope) values (?, ?, ?, ?, ?)",
      ["executor", "Executor", "[]", "none", "discord:read discord:write"],
    );
    for (const [grantId, owner] of [["grant-1", userId], ["grant-2", withoutAccount]] as const)
      await exec("insert into oauth_grant (id, user_id, client_id, scope) values (?, ?, ?, ?)", [grantId, owner, "executor", "discord:read discord:write"]);
    const refresh = SlotCredential.generate();
    await exec("insert into key_slot (id, user_id, kind, verifier, grant_id, expires_at) values (?, ?, ?, ?, ?, ?)", [
      refresh.slotId,
      userId,
      "oauth_refresh",
      KeySlot.verifierFor(vault.pepper, refresh),
      "grant-1",
      Date.now() + 60_000,
    ]);

    await migrate(db, { migrationsFolder });

    const rows = await db.$client.execute("select id, user_id, discord_user_id, status, presence_on_write, last_verified_at from discord_account");
    expect(rows.rows.map((row) => ({ id: row.id, user_id: row.user_id, discord_user_id: row.discord_user_id, status: row.status, presence_on_write: row.presence_on_write, last_verified_at: row.last_verified_at }))).toEqual([
      { id: userId, user_id: userId, discord_user_id: null, status: "active", presence_on_write: 1, last_verified_at: 1_000 },
    ]);
    const key = { userId, accountId: userId };
    const credentials = (await DiscordAccountStore.credentialsWith(db, vault, key)).unwrap();
    expect(credentials?.token).toBe("test-token-not-real");
    expect(credentials?.record).toMatchObject({ id: userId, presenceOnWrite: true, user: profile });

    const grants = await db.$client.execute("select id, discord_account_id, revoked_at from oauth_grant order by id");
    expect(grants.rows.map((row) => ({ id: row.id, discord_account_id: row.discord_account_id, revoked_at: row.revoked_at }))).toEqual([
      { id: "grant-1", discord_account_id: userId, revoked_at: null },
      { id: "grant-2", discord_account_id: null, revoked_at: null },
    ]);
    const opened = await KeySlot.open(db, vault, { credential: refresh, kind: "oauth_refresh", userId });
    expect(opened.isOk() && opened.value.grantId).toBe("grant-1");

    // Logging in to the same Discord account refreshes the migrated row; another account is added beside it.
    const again = (await DiscordAccountStore.saveWith(db, vault, userId, { token: "test-token-new-not-real", user: profile })).unwrap();
    expect(again.id).toBe(userId);
    const added = (await DiscordAccountStore.saveWith(db, vault, userId, { token: "test-token-alt-not-real", user: { ...profile, id: "456" } })).unwrap();
    expect(added.id).not.toBe(userId);
    const after = await db.$client.execute("select id, discord_user_id from discord_account order by created_at, id");
    expect(after.rows).toHaveLength(2);
    expect(after.rows.map((row) => row.discord_user_id).sort()).toEqual(["123", "456"]);
  });
});
