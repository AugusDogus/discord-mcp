import { expect, test } from "bun:test";
import { Result } from "better-result";
import { z } from "zod";
import { DiscordRest, type DiscordFetch } from "./rest";

const make = (fetch: DiscordFetch) =>
  DiscordRest.create("test-token-not-real", { fetch, rejected: async () => Result.ok(undefined) });
test("REST reads use a token without opening a gateway; writes preserve JSON and forbid redirects", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const rest = make(async (url, init) => {
    requests.push({ url, init });
    return Response.json({ id: "123" });
  });
  expect((await rest.request("read account", "/users/@me", z.object({ id: z.string() }))).unwrap()).toEqual({
    id: "123",
  });
  await rest.request("send", "/channels/123/messages", z.unknown(), { method: "POST", body: { content: "test" } });
  expect(requests[0]?.url).toBe("https://discord.com/api/v9/users/@me");
  expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("test-token-not-real");
  expect(requests[1]?.init).toMatchObject({ method: "POST", body: '{"content":"test"}', redirect: "error" });
});
test("401 marks the account rejected and blocks subsequent requests", async () => {
  let marked = 0;
  let fetched = 0;
  const rest = DiscordRest.create("test-token-not-real", {
    fetch: async () => {
      fetched++;
      return new Response("test-token-not-real", { status: 401 });
    },
    rejected: async () => {
      marked++;
      return Result.ok(undefined);
    },
  });
  const result = await rest.request("read", "/users/@me", z.unknown());
  expect(result.isErr()).toBe(true);
  expect(JSON.stringify(result)).not.toContain("test-token-not-real");
  await rest.request("read again", "/users/@me", z.unknown());
  expect(marked).toBe(1);
  expect(fetched).toBe(1);
});
test("rate limits, network errors, bad JSON and schema failures are explicit, with no automatic write retries", async () => {
  for (const fetch of [
    async () => new Response("test-token-not-real", { status: 429 }),
    async () => {
      throw new Error("test-token-not-real");
    },
    async () => new Response("invalid"),
    async () => Response.json({ id: 123 }),
  ]) {
    let calls = 0;
    const rest = make(async () => {
      calls++;
      return fetch();
    });
    const result = await rest.request("send", "/channels/123/messages", z.object({ id: z.string() }), {
      method: "POST",
    });
    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-token-not-real");
    expect(calls).toBe(1);
  }
});
test("204 is a successful empty response; rejection persistence errors are propagated", async () => {
  expect(
    (
      await make(async () => new Response(null, { status: 204 })).request("delete", "/test", z.null(), {
        method: "DELETE",
      })
    ).unwrap(),
  ).toBeNull();
  const rest = DiscordRest.create("test-token-not-real", {
    fetch: async () => new Response(null, { status: 401 }),
    rejected: async () => Result.err({ message: "Database unavailable; retry later." }),
  });
  expect((await rest.request("read", "/test", z.unknown())).match({ ok: () => "", err: (e) => e.message })).toContain(
    "Database unavailable",
  );
});
