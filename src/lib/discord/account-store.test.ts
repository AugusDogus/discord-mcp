import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { discordAccount } from "@/lib/db/app-schema";
import { ServerKey } from "@/lib/vault";
import { VaultTesting, type TestDatabase } from "@/lib/vault/testing";
import { DiscordAccountStore, type DiscordAccountRecord } from "./account-store";
import type { DiscordUser } from "./user";

const TOKEN = "test-token-not-real";
const user: DiscordUser = { id: "123", username: "alice", globalName: "Alice", discriminator: "0", avatar: null };
const other: DiscordUser = { id: "456", username: "alt", globalName: "Alt", discriminator: "0", avatar: null };

let database: TestDatabase;
beforeEach(async () => {
  database = await VaultTesting.createDb();
});
afterEach(() => database.cleanup());

const keyOf = (record: DiscordAccountRecord) => ({ userId: record.userId, accountId: record.id });

describe("token sealing", () => {
  test("the token and profile are stored only as DEK envelopes and read back with the server key", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const userId = await VaultTesting.createUser(db);
    const saved = (await DiscordAccountStore.saveWith(db, config, userId, { token: TOKEN, user })).unwrap();

    const [row] = await db.select().from(discordAccount);
    expect(row?.tokenEnc.startsWith("d1.")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain("alice");
    expect(row?.discordUserId).toBe("123");

    const credentials = (await DiscordAccountStore.credentialsWith(db, config, keyOf(saved))).unwrap();
    expect(credentials?.token).toBe(TOKEN);
    expect(credentials?.record).toMatchObject({ id: saved.id, status: "active", presenceOnWrite: false, user });
  });

  test("another KEY_PEPPER cannot open it, and logging in again replaces the key and refreshes the same row", async () => {
    const { db } = database;
    const userId = await VaultTesting.createUser(db);
    const saved = (await DiscordAccountStore.saveWith(db, VaultTesting.vaultConfig(), userId, { token: TOKEN, user })).unwrap();

    const rotated = VaultTesting.vaultConfig();
    const read = await DiscordAccountStore.credentialsWith(db, rotated, keyOf(saved));
    expect(read.match({ ok: () => null, err: (e) => e })).toMatchObject({ _tag: "DiscordAccountUnreadableError", reason: "key_invalid" });
    expect((await DiscordAccountStore.listWith(db, rotated, userId)).unwrap()).toMatchObject([{ kind: "unreadable", id: saved.id }]);

    const again = (await DiscordAccountStore.saveWith(db, rotated, userId, { token: "test-token-new-not-real", user })).unwrap();
    expect(again.id).toBe(saved.id);
    expect((await DiscordAccountStore.credentialsWith(db, rotated, keyOf(again))).unwrap()?.token).toBe("test-token-new-not-real");
    expect(await db.select().from(discordAccount)).toHaveLength(1);
  });

  test("a row sealed for one user does not open as another's", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const alice = await VaultTesting.createUser(db);
    const bob = await VaultTesting.createUser(db);
    const aliceAccount = (await DiscordAccountStore.saveWith(db, config, alice, { token: TOKEN, user })).unwrap();
    const bobAccount = (await DiscordAccountStore.saveWith(db, config, bob, { token: "test-token-bob-not-real", user })).unwrap();
    const [aliceRow] = await db.select().from(discordAccount).where(eq(discordAccount.userId, alice));
    const bobKey = (await ServerKey.unlockWith(db, config, bob)).unwrap();
    await db
      .update(discordAccount)
      .set({ tokenEnc: aliceRow?.tokenEnc ?? "", dekId: bobKey?.id ?? "" })
      .where(eq(discordAccount.userId, bob));
    const read = await DiscordAccountStore.credentialsWith(db, config, keyOf(bobAccount));
    expect(read.match({ ok: () => null, err: (e) => e })).toMatchObject({ reason: "envelope" });
    expect((await DiscordAccountStore.credentialsWith(db, config, keyOf(aliceAccount))).unwrap()?.token).toBe(TOKEN);
  });

  test("the presence setting survives a new login; rejected status is recorded", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const userId = await VaultTesting.createUser(db);
    const saved = (await DiscordAccountStore.saveWith(db, config, userId, { token: TOKEN, user })).unwrap();
    expect((await DiscordAccountStore.setPresenceOnWrite(db, keyOf(saved), true)).unwrap()).toBe(true);
    (await DiscordAccountStore.markRejected(db, keyOf(saved))).unwrap();
    expect((await DiscordAccountStore.credentialsWith(db, config, keyOf(saved))).unwrap()?.record.status).toBe("rejected");
    (await DiscordAccountStore.saveWith(db, config, userId, { token: TOKEN, user })).unwrap();
    const record = (await DiscordAccountStore.credentialsWith(db, config, keyOf(saved))).unwrap()?.record;
    expect(record).toMatchObject({ status: "active", presenceOnWrite: true });
  });
});

describe("several accounts per user", () => {
  test("two Discord accounts get their own rows, tokens and settings, listed oldest first", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const userId = await VaultTesting.createUser(db);
    const first = (await DiscordAccountStore.saveWith(db, config, userId, { token: TOKEN, user })).unwrap();
    const second = (await DiscordAccountStore.saveWith(db, config, userId, { token: "test-token-alt-not-real", user: other })).unwrap();
    expect(second.id).not.toBe(first.id);
    expect((await DiscordAccountStore.setPresenceOnWrite(db, keyOf(second), true)).unwrap()).toBe(true);
    (await DiscordAccountStore.markRejected(db, keyOf(first))).unwrap();

    const listed = (await DiscordAccountStore.listWith(db, config, userId)).unwrap();
    expect(listed.map((entry) => (entry.kind === "readable" ? [entry.record.user.id, entry.record.status, entry.record.presenceOnWrite] : null))).toEqual([
      ["123", "rejected", false],
      ["456", "active", true],
    ]);
    expect(JSON.stringify(listed)).not.toContain("test-token");
    expect((await DiscordAccountStore.credentialsWith(db, config, keyOf(second))).unwrap()?.token).toBe("test-token-alt-not-real");
  });

  test("logging in to a stored account again refreshes it instead of adding a duplicate", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const userId = await VaultTesting.createUser(db);
    const first = (await DiscordAccountStore.saveWith(db, config, userId, { token: TOKEN, user })).unwrap();
    (await DiscordAccountStore.saveWith(db, config, userId, { token: "test-token-alt-not-real", user: other })).unwrap();
    const renamed = { ...user, globalName: "Alice Renamed" };
    const again = (await DiscordAccountStore.saveWith(db, config, userId, { token: "test-token-new-not-real", user: renamed })).unwrap();
    expect(again.id).toBe(first.id);
    expect(await db.select().from(discordAccount)).toHaveLength(2);
    const credentials = (await DiscordAccountStore.credentialsWith(db, config, keyOf(first))).unwrap();
    expect(credentials?.token).toBe("test-token-new-not-real");
    expect(credentials?.record.user.globalName).toBe("Alice Renamed");
  });

  test("a row stored before accounts had ids is matched by its sealed profile, and a check fills in its Discord id", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const userId = await VaultTesting.createUser(db);
    const legacy = (await DiscordAccountStore.saveWith(db, config, userId, { token: TOKEN, user })).unwrap();
    await db.update(discordAccount).set({ discordUserId: null }).where(eq(discordAccount.id, legacy.id));

    const again = (await DiscordAccountStore.saveWith(db, config, userId, { token: "test-token-new-not-real", user })).unwrap();
    expect(again.id).toBe(legacy.id);
    expect(await db.select({ discordUserId: discordAccount.discordUserId }).from(discordAccount)).toEqual([{ discordUserId: "123" }]);

    await db.update(discordAccount).set({ discordUserId: null }).where(eq(discordAccount.id, legacy.id));
    (await DiscordAccountStore.markVerifiedWith(db, config, keyOf(legacy), user)).unwrap();
    expect(await db.select({ discordUserId: discordAccount.discordUserId }).from(discordAccount)).toEqual([{ discordUserId: "123" }]);
  });

  test("users are isolated: the same Discord account under two users is two rows, and keys never cross", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const alice = await VaultTesting.createUser(db);
    const bob = await VaultTesting.createUser(db);
    const aliceAccount = (await DiscordAccountStore.saveWith(db, config, alice, { token: TOKEN, user })).unwrap();
    const bobAccount = (await DiscordAccountStore.saveWith(db, config, bob, { token: "test-token-bob-not-real", user })).unwrap();
    expect(bobAccount.id).not.toBe(aliceAccount.id);

    expect((await DiscordAccountStore.credentialsWith(db, config, { userId: bob, accountId: aliceAccount.id })).unwrap()).toBeNull();
    expect((await DiscordAccountStore.setPresenceOnWrite(db, { userId: bob, accountId: aliceAccount.id }, true)).unwrap()).toBe(false);
    (await DiscordAccountStore.markRejected(db, { userId: bob, accountId: aliceAccount.id })).unwrap();
    expect((await DiscordAccountStore.credentialsWith(db, config, keyOf(aliceAccount))).unwrap()?.record).toMatchObject({
      status: "active",
      presenceOnWrite: false,
    });
    const bobList = (await DiscordAccountStore.listWith(db, config, bob)).unwrap();
    expect(bobList.map((entry) => (entry.kind === "readable" ? entry.record.id : entry.id))).toEqual([bobAccount.id]);
  });
});
