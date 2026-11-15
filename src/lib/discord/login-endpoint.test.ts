import { expect, test } from "bun:test";
import { Result } from "better-result";
import { RequestRejectedError } from "@/lib/http/request-guard";
import { LoginEndpoint, type LoginEndpointDeps } from "./login-endpoint";

const origin = "https://discord-mcp.test";
const calls: string[] = [];
const deps: LoginEndpointDeps = {
  origin,
  session: async () => Result.ok({ userId: "123" }),
  sessions: {
    poll: async (id) => {
      calls.push(id);
      return { stage: "qr", url: "https://discord.com/ra/test", expiresAt: 123 };
    },
    restart: (id) => {
      calls.push(id);
      return { stage: "starting" };
    },
  },
};
test("poll returns only the signed-in user's view and prevents caching", async () => {
  calls.length = 0;
  const response = await LoginEndpoint.handle(deps, new Request(`${origin}/api/discord/login`));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ stage: "qr" });
  expect(calls).toEqual(["123"]);
});
test("restart requires same origin and a session", async () => {
  calls.length = 0;
  for (const headers of [new Headers(), new Headers({ origin: "https://other.test" })]) {
    expect(
      (await LoginEndpoint.handle(deps, new Request(`${origin}/api/discord/login`, { method: "POST", headers })))
        .status,
    ).toBe(403);
  }
  for (const site of ["cross-site", "same-site"]) {
    expect(
      (
        await LoginEndpoint.handle(
          deps,
          new Request(`${origin}/api/discord/login`, { headers: { "sec-fetch-site": site } }),
        )
      ).status,
    ).toBe(403);
  }
  const signedOut: LoginEndpointDeps = {
    ...deps,
    session: async () => Result.err(new RequestRejectedError({ status: 401, message: "Sign in again." })),
  };
  expect((await LoginEndpoint.handle(signedOut, new Request(`${origin}/api/discord/login`))).status).toBe(401);
  expect(calls).toEqual([]);
  expect(
    (
      await LoginEndpoint.handle(
        deps,
        new Request(`${origin}/api/discord/login`, { method: "POST", headers: { origin } }),
      )
    ).status,
  ).toBe(200);
  expect(calls).toEqual(["123"]);
});

test("same-origin browser polling works behind a proxy with an internal request URL", async () => {
  const response = await LoginEndpoint.handle(
    deps,
    new Request("http://127.0.0.1:3000/api/discord/login", { headers: { "sec-fetch-site": "same-origin" } }),
  );
  expect(response.status).toBe(200);
  const restarted = await LoginEndpoint.handle(
    deps,
    new Request("http://127.0.0.1:3000/api/discord/login", { method: "POST", headers: { origin } }),
  );
  expect(restarted.status).toBe(200);
});
