import { expect, test } from "bun:test";
import { Result } from "better-result";
import { DiscordAccountHealth, type AccountHealthDeps } from "./account-health";
import { DiscordRest } from "./rest";

const user = { id: "123", username: "test", globalName: null, discriminator: "0", avatar: null };
test("account health caches /users/@me for a minute and refreshes an expired profile", async () => {
  let now = 1_000;
  let fetched = 0;
  let verified = 0;
  const deps: AccountHealthDeps = {
    now: () => now,
    credentials: async () =>
      Result.ok({
        token: "test-token-not-real",
        record: { userId: "123", status: "active", presenceOnWrite: false, user, lastVerifiedAt: new Date(0) },
      }),
    rest: () =>
      DiscordRest.create("test-token-not-real", {
        fetch: async () => {
          fetched++;
          return Response.json(user);
        },
        rejected: async () => Result.ok(null),
      }),
    verified: async () => {
      verified++;
      return Result.ok(null);
    },
  };
  expect((await DiscordAccountHealth.check(deps, "123")).unwrap()).toMatchObject({
    kind: "connected",
    health: "verified",
  });
  expect(fetched).toBe(0);
  now = 60_000;
  expect((await DiscordAccountHealth.check(deps, "123")).unwrap()).toMatchObject({
    kind: "connected",
    health: "verified",
  });
  expect(fetched).toBe(1);
  expect(verified).toBe(1);
  const rejected = {
    ...deps,
    rest: () =>
      DiscordRest.create("test-token-not-real", {
        fetch: async () => new Response(null, { status: 401 }),
        rejected: async () => Result.ok(null),
      }),
  };
  expect((await DiscordAccountHealth.check(rejected, "123")).unwrap()).toEqual({ kind: "login" });
  const offline = {
    ...deps,
    rest: () =>
      DiscordRest.create("test-token-not-real", {
        fetch: async () => {
          throw new Error("offline");
        },
        rejected: async () => Result.ok(null),
      }),
  };
  expect((await DiscordAccountHealth.check(offline, "123")).unwrap()).toMatchObject({
    kind: "connected",
    health: "unknown",
  });
});
