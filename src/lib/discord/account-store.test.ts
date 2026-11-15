import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { discordAccount } from "@/lib/db/app-schema";
import { ServerKey } from "@/lib/vault";
import { VaultTesting, type TestDatabase } from "@/lib/vault/testing";
import { DiscordAccountStore } from "./account-store";
import type { DiscordUser } from "./user";

const TOKEN = "test-token-not-real";
const user: DiscordUser = { id: "123", username: "alice", globalName: "Alice", discriminator: "0", avatar: null };

let database: TestDatabase;
beforeEach(async () => {
  database = await VaultTesting.createDb();
});
afterEach(() => database.cleanup());

describe("token sealing", () => {
  test("the token and profile are stored only as DEK envelopes and read back with the server key", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const userId = await VaultTesting.createUser(db);
    (await DiscordAccountStore.saveWith(db, config, userId, { token: TOKEN, user })).unwrap();

    const [row] = await db.select().from(discordAccount);
    expect(row?.tokenEnc.startsWith("d1.")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain("alice");

    const credentials = (await DiscordAccountStore.credentialsWith(db, config, userId)).unwrap();
    expect(credentials?.token).toBe(TOKEN);
    expect(credentials?.record).toMatchObject({ status: "active", presenceOnWrite: false, user });
  });

  test("another KEY_PEPPER cannot open it, and logging in again replaces the key", async () => {
    const { db } = database;
    const userId = await VaultTesting.createUser(db);
    (await DiscordAccountStore.saveWith(db, VaultTesting.vaultConfig(), userId, { token: TOKEN, user })).unwrap();

    const rotated = VaultTesting.vaultConfig();
    const read = await DiscordAccountStore.credentialsWith(db, rotated, userId);
    expect(read.match({ ok: () => null, err: (e) => e })).toMatchObject({ _tag: "DiscordAccountUnreadableError", reason: "key_invalid" });

    (await DiscordAccountStore.saveWith(db, rotated, userId, { token: "new-token", user })).unwrap();
    expect((await DiscordAccountStore.credentialsWith(db, rotated, userId)).unwrap()?.token).toBe("new-token");
  });

  test("a row sealed for one user does not open as another's", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const alice = await VaultTesting.createUser(db);
    const bob = await VaultTesting.createUser(db);
    (await DiscordAccountStore.saveWith(db, config, alice, { token: TOKEN, user })).unwrap();
    (await DiscordAccountStore.saveWith(db, config, bob, { token: "bob-token", user })).unwrap();
    const [aliceRow] = await db.select().from(discordAccount).where(eq(discordAccount.userId, alice));
    const bobKey = (await ServerKey.unlockWith(db, config, bob)).unwrap();
    await db
      .update(discordAccount)
      .set({ tokenEnc: aliceRow?.tokenEnc ?? "", dekId: bobKey?.id ?? "" })
      .where(eq(discordAccount.userId, bob));
    const read = await DiscordAccountStore.credentialsWith(db, config, bob);
    expect(read.match({ ok: () => null, err: (e) => e })).toMatchObject({ reason: "envelope" });
  });

  test("the presence setting survives a new login; rejected status is recorded", async () => {
    const { db } = database;
    const config = VaultTesting.vaultConfig();
    const userId = await VaultTesting.createUser(db);
    (await DiscordAccountStore.saveWith(db, config, userId, { token: TOKEN, user })).unwrap();
    expect((await DiscordAccountStore.setPresenceOnWrite(db, userId, true)).unwrap()).toBe(true);
    (await DiscordAccountStore.markRejected(db, userId)).unwrap();
    expect((await DiscordAccountStore.credentialsWith(db, config, userId)).unwrap()?.record.status).toBe("rejected");
    (await DiscordAccountStore.saveWith(db, config, userId, { token: TOKEN, user })).unwrap();
    const record = (await DiscordAccountStore.credentialsWith(db, config, userId)).unwrap()?.record;
    expect(record).toMatchObject({ status: "active", presenceOnWrite: true });
  });
});
