import { expect, test } from "bun:test";
import { Result } from "better-result";
import { RequestRejectedError } from "@/lib/http/request-guard";
import { DiscordAccountEndpoint, type AccountEndpointDeps } from "./account-endpoint";

const origin = "https://discord-mcp.test";
const request = (body: unknown) =>
  new Request(`${origin}/api/discord/presence`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
test("account actions name one account of the session owner and validate presence booleans", async () => {
  const calls: unknown[] = [];
  const deps: AccountEndpointDeps = {
    guard: async () => Result.ok({ userId: "123" }),
    presence: async (account, enabled) => {
      calls.push({ account, enabled });
      return Result.ok(account.accountId === "test-account");
    },
    logout: async (account) => {
      calls.push(account);
      return Result.ok(undefined);
    },
  };
  for (const body of [{}, { enabled: false }, { accountId: "test-account", enabled: "false" }, { accountId: "test-account", enabled: true, userId: "456" }])
    expect((await DiscordAccountEndpoint.handle(deps, request(body), "presence")).status).toBe(400);
  expect(calls).toEqual([]);
  expect((await DiscordAccountEndpoint.handle(deps, request({ accountId: "test-account", enabled: false }), "presence")).status).toBe(200);
  expect(calls).toEqual([{ account: { userId: "123", accountId: "test-account" }, enabled: false }]);
  expect((await DiscordAccountEndpoint.handle(deps, request({ accountId: "other-account", enabled: true }), "presence")).status).toBe(404);
  const rejected = {
    ...deps,
    guard: async () => Result.err(new RequestRejectedError({ status: 403, message: "Wrong origin." })),
  };
  expect((await DiscordAccountEndpoint.handle(rejected, request({ accountId: "test-account" }), "logout")).status).toBe(403);
  expect(calls).toHaveLength(2);
  expect((await DiscordAccountEndpoint.handle(deps, request({}), "logout")).status).toBe(400);
  expect((await DiscordAccountEndpoint.handle(deps, request({ accountId: "test-account", userId: "456" }), "logout")).status).toBe(400);
  expect((await DiscordAccountEndpoint.handle(deps, request({ accountId: "test-account" }), "logout")).status).toBe(200);
  expect(calls.at(-1)).toEqual({ userId: "123", accountId: "test-account" });
});
