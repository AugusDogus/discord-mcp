import { afterEach, beforeEach, expect, test } from "bun:test";
import { Result } from "better-result";
import { discordAccount } from "@/lib/db/app-schema";
import { keySlot, oauthClient, oauthGrant, userKey } from "@/lib/db/vault-schema";
import { VaultTesting, type TestDatabase } from "@/lib/vault/testing";
import { DiscordAccountStore } from "./account-store";
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
const setup = async (response: () => Response) => {
  const config = VaultTesting.vaultConfig();
  const userId = await VaultTesting.createUser(database.db, "123");
  const other = await VaultTesting.createUser(database.db, "456");
  for (const id of [userId, other])
    (await DiscordAccountStore.saveWith(database.db, config, id, { token: "test-token-not-real", user })).unwrap();
  await database.db
    .insert(oauthClient)
    .values({
      clientId: "test-client",
      clientName: "Test",
      redirectUrisJson: "[]",
      tokenEndpointAuthMethod: "none",
      scope: "discord:read",
    });
  for (const id of [userId, other]) {
    await database.db
      .insert(oauthGrant)
      .values({ id: `grant-${id}`, userId: id, clientId: "test-client", scope: "discord:read" });
    await database.db
      .insert(keySlot)
      .values({
        id: `slot-${id}`,
        userId: id,
        grantId: `grant-${id}`,
        kind: "oauth_refresh",
        verifier: "test-verifier-not-real",
      });
  }
  const calls: { url: string; method: string | undefined }[] = [];
  let stopped = false;
  const deps = {
    db: database.db,
    credentials: (id: string) => DiscordAccountStore.credentialsWith(database.db, config, id),
    stop: () => {
      stopped = true;
    },
    rest: (_: string, token: string) =>
      DiscordRest.create(token, {
        fetch: async (url, init) => {
          expect(stopped).toBe(true);
          calls.push({ url, method: init.method });
          return response();
        },
        rejected: () => DiscordAccountStore.markRejected(database.db, userId),
      }),
  };
  return { deps, calls, userId };
};
test("logout posts to Discord, then atomically removes only the owner's token, key, grants and credentials", async () => {
  const h = await setup(() => new Response(null, { status: 204 }));
  expect((await DiscordLogout.run(h.deps, h.userId)).isOk()).toBe(true);
  expect(h.calls).toEqual([{ url: "https://discord.com/api/v9/auth/logout", method: "POST" }]);
  for (const table of [discordAccount, userKey, oauthGrant, keySlot]) {
    const rows = await database.db.select({ userId: table.userId }).from(table);
    expect(rows).toEqual([{ userId: "456" }]);
  }
  // A retry after cleanup is idempotent and does not call Discord again.
  expect((await DiscordLogout.run(h.deps, h.userId)).isOk()).toBe(true);
  expect(h.calls).toHaveLength(1);
});
test("an already rejected token still permits local logout; a remote outage preserves local data", async () => {
  const h = await setup(() => new Response(null, { status: 503 }));
  expect((await DiscordLogout.run(h.deps, h.userId)).isErr()).toBe(true);
  for (const table of [discordAccount, userKey, oauthGrant, keySlot])
    expect(await database.db.select().from(table)).toHaveLength(2);
  const rejected = {
    ...h.deps,
    rest: (_: string, token: string) =>
      DiscordRest.create(token, {
        fetch: async () => new Response(null, { status: 401 }),
        rejected: async () => Result.ok(null),
      }),
  };
  expect((await DiscordLogout.run(rejected, h.userId)).isOk()).toBe(true);
  expect(await database.db.select().from(discordAccount)).toHaveLength(1);
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
