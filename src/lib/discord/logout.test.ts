import { afterEach, beforeEach, expect, test } from "bun:test";
import { Result } from "better-result";
import { discordAccount } from "@/lib/db/app-schema";
import { keySlot, oauthClient, oauthGrant, userKey } from "@/lib/db/vault-schema";
import { VaultTesting, type TestDatabase } from "@/lib/vault/testing";
import { DiscordAccountStore, type DiscordAccountKey } from "./account-store";
import { DiscordAccountLease } from "./account-lease";
import { DiscordLogout } from "./logout";
import { DiscordRest } from "./rest";

let database: TestDatabase;
beforeEach(async () => {
  database = await VaultTesting.createDb();
});
afterEach(async () => {
  await database.cleanup();
});
const user = { id: "123", username: "test", globalName: null, discriminator: "0", avatar: null };
const alt = { ...user, id: "789", username: "alt" };

/** User 123 with two Discord accounts and user 456 with one, each account with an agent grant and refresh slot. */
const setup = async (response: () => Response) => {
  const config = VaultTesting.vaultConfig();
  const userId = await VaultTesting.createUser(database.db, "123");
  const other = await VaultTesting.createUser(database.db, "456");
  const save = async (id: string, profile: typeof user) =>
    (await DiscordAccountStore.saveWith(database.db, config, id, { token: "test-token-not-real", user: profile })).unwrap();
  const first = await save(userId, user);
  const second = await save(userId, alt);
  const foreign = await save(other, user);
  await database.db
    .insert(oauthClient)
    .values({
      clientId: "test-client",
      clientName: "Test",
      redirectUrisJson: "[]",
      tokenEndpointAuthMethod: "none",
      scope: "discord:read",
    });
  for (const account of [first, second, foreign]) {
    await database.db
      .insert(oauthGrant)
      .values({ id: `grant-${account.id}`, userId: account.userId, discordAccountId: account.id, clientId: "test-client", scope: "discord:read" });
    await database.db
      .insert(keySlot)
      .values({
        id: `slot-${account.id}`,
        userId: account.userId,
        grantId: `grant-${account.id}`,
        kind: "oauth_refresh",
        verifier: "test-verifier-not-real",
      });
  }
  const calls: { url: string; method: string | undefined }[] = [];
  const stopped: string[] = [];
  const deps = {
    db: database.db,
    credentials: (key: DiscordAccountKey) => DiscordAccountStore.credentialsWith(database.db, config, key),
    stop: (key: DiscordAccountKey) => {
      stopped.push(key.accountId);
    },
    now: () => 1_000,
    rest: (key: DiscordAccountKey, token: string) =>
      DiscordRest.create(token, {
        fetch: async (url, init) => {
          expect(stopped).toContain(key.accountId);
          calls.push({ url, method: init.method });
          return response();
        },
        rejected: () => DiscordAccountStore.markRejected(database.db, key),
      }),
  };
  return { deps, calls, stopped, userId, first, second, foreign, config };
};
const grants = () =>
  database.db
    .select({ id: oauthGrant.id, revokedAt: oauthGrant.revokedAt, revokedReason: oauthGrant.revokedReason, discordAccountId: oauthGrant.discordAccountId })
    .from(oauthGrant);
const keyOf = (account: { readonly userId: string; readonly id: string }) => ({ userId: account.userId, accountId: account.id });

test("logging out one account signs it out of Discord, then removes only its row and revokes only its grants", async () => {
  const h = await setup(() => new Response(null, { status: 204 }));
  expect((await DiscordLogout.run(h.deps, keyOf(h.first))).isOk()).toBe(true);
  expect(h.calls).toEqual([{ url: "https://discord.com/api/v9/auth/logout", method: "POST" }]);
  expect(h.stopped).toEqual([h.first.id]);
  expect((await database.db.select({ id: discordAccount.id }).from(discordAccount)).map((row) => row.id).sort()).toEqual(
    [h.second.id, h.foreign.id].sort(),
  );
  const byId = new Map((await grants()).map((grant) => [grant.id, grant]));
  expect(byId.get(`grant-${h.first.id}`)).toMatchObject({ revokedAt: 1_000, revokedReason: "discord_account_logged_out", discordAccountId: null });
  expect(byId.get(`grant-${h.second.id}`)).toMatchObject({ revokedAt: null, discordAccountId: h.second.id });
  expect(byId.get(`grant-${h.foreign.id}`)).toMatchObject({ revokedAt: null, discordAccountId: h.foreign.id });
  // The user still has an account, so their server key stays.
  expect((await database.db.select({ userId: userKey.userId }).from(userKey)).map((row) => row.userId).sort()).toEqual(["123", "456"]);
  expect((await DiscordAccountStore.credentialsWith(database.db, h.config, keyOf(h.second))).unwrap()?.token).toBe("test-token-not-real");

  // A retry after cleanup is idempotent and does not call Discord again.
  expect((await DiscordLogout.run(h.deps, keyOf(h.first))).isOk()).toBe(true);
  expect(h.calls).toHaveLength(1);
});

test("logging out the last account also removes the user's server key; other users keep theirs", async () => {
  const h = await setup(() => new Response(null, { status: 204 }));
  for (const account of [h.first, h.second]) expect((await DiscordLogout.run(h.deps, keyOf(account))).isOk()).toBe(true);
  expect((await database.db.select({ userId: discordAccount.userId }).from(discordAccount))).toEqual([{ userId: "456" }]);
  expect((await database.db.select({ userId: userKey.userId }).from(userKey))).toEqual([{ userId: "456" }]);
});

test("another user cannot log out an account they do not own", async () => {
  const h = await setup(() => new Response(null, { status: 204 }));
  expect((await DiscordLogout.run(h.deps, { userId: "456", accountId: h.first.id })).isOk()).toBe(true);
  expect(h.calls).toEqual([]);
  expect(await database.db.select().from(discordAccount)).toHaveLength(3);
  expect((await grants()).every((grant) => grant.revokedAt === null)).toBe(true);
});

test("an already rejected token still permits local logout; a remote outage preserves local data", async () => {
  const h = await setup(() => new Response(null, { status: 503 }));
  expect((await DiscordLogout.run(h.deps, keyOf(h.first))).isErr()).toBe(true);
  expect(await database.db.select().from(discordAccount)).toHaveLength(3);
  expect((await grants()).every((grant) => grant.revokedAt === null)).toBe(true);
  const rejected = {
    ...h.deps,
    rest: (_: DiscordAccountKey, token: string) =>
      DiscordRest.create(token, {
        fetch: async () => new Response(null, { status: 401 }),
        rejected: async () => Result.ok(null),
      }),
  };
  expect((await DiscordLogout.run(rejected, keyOf(h.first))).isOk()).toBe(true);
  expect(await database.db.select().from(discordAccount)).toHaveLength(2);
});

test("a login the server key no longer opens is removed locally without calling Discord", async () => {
  const h = await setup(() => new Response(null, { status: 204 }));
  const rotated = { ...h.deps, credentials: (key: DiscordAccountKey) => DiscordAccountStore.credentialsWith(database.db, VaultTesting.vaultConfig(), key) };
  expect((await DiscordLogout.run(rotated, keyOf(h.first))).isOk()).toBe(true);
  expect(h.calls).toEqual([]);
  expect(await database.db.select().from(discordAccount)).toHaveLength(2);
});
test("the account lease waits for an action, serializes logout and releases after failures", async () => {
  const lease = DiscordAccountLease.create();
  const events: string[] = [];
  let release: () => void = () => {};
  const running = lease.run("123", async () => {
    events.push("action");
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    events.push("finished");
  });
  const logout = lease.run("123", async () => {
    events.push("logout");
  });
  await lease.run("456", async () => {
    events.push("other user");
  });
  expect(events).toEqual(["action", "other user"]);
  release();
  await running;
  await logout;
  expect(events).toEqual(["action", "other user", "finished", "logout"]);
  await expect(
    lease.run("123", async () => {
      throw new Error("test exception");
    }),
  ).rejects.toThrow("test exception");
  await lease.run("123", async () => {
    events.push("released");
  });
  expect(events.at(-1)).toBe("released");
});
