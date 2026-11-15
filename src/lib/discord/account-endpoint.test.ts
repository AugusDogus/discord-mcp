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
test("account actions use the session owner and validate presence booleans", async () => {
  const calls: unknown[] = [];
  const deps: AccountEndpointDeps = {
    guard: async () => Result.ok({ userId: "123" }),
    presence: async (id, enabled) => {
      calls.push({ id, enabled });
      return Result.ok(true);
    },
    logout: async (id) => {
      calls.push(id);
      return Result.ok(undefined);
    },
  };
  for (const body of [{}, { enabled: "false" }, { enabled: true, userId: "456" }])
    expect((await DiscordAccountEndpoint.handle(deps, request(body), "presence")).status).toBe(400);
  expect(calls).toEqual([]);
  expect((await DiscordAccountEndpoint.handle(deps, request({ enabled: false }), "presence")).status).toBe(200);
  expect(calls).toEqual([{ id: "123", enabled: false }]);
  const rejected = {
    ...deps,
    guard: async () => Result.err(new RequestRejectedError({ status: 403, message: "Wrong origin." })),
  };
  expect((await DiscordAccountEndpoint.handle(rejected, request({}), "logout")).status).toBe(403);
  expect(calls).toHaveLength(1);
  expect((await DiscordAccountEndpoint.handle(deps, request({}), "logout")).status).toBe(200);
  expect(calls.at(-1)).toBe("123");
});
