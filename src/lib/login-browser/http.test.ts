import { expect, test } from "bun:test";
import { Result } from "better-result";
import { RequestRejectedError } from "@/lib/http/request-guard";
import { LoginHttp, type LoginHttpDeps } from "./http";
import { createHarness } from "./testing";

const origin = "https://discord-mcp.test";
const request = (action: unknown, headers: HeadersInit = { origin }) => new Request("http://127.0.0.1:3100/api/discord/login", { method: "POST", headers, body: JSON.stringify(action) });
const harness = () => {
  const h = createHarness();
  const deps: LoginHttpDeps = { origin, browser: h.login, session: async () => Result.ok({ userId: "123" }) };
  return { ...h, deps };
};

test("login actions require the exact app origin and a session", async () => {
  const { deps } = harness();
  for (const headers of [new Headers(), new Headers({ origin: "https://other.test" })]) expect((await LoginHttp.action(deps, request({ action: "start", colorScheme: "light" }, headers))).status).toBe(403);
  const signedOut: LoginHttpDeps = { ...deps, session: async () => Result.err(new RequestRejectedError({ status: 401, message: "Sign in again." })) };
  expect((await LoginHttp.action(signedOut, request({ action: "start", colorScheme: "light" }))).status).toBe(401);
  expect((await LoginHttp.action(deps, request({ action: "start" }))).status).toBe(400);
});

test("start, poll and stop work behind nginx and never cache", async () => {
  const { deps } = harness();
  const start = await LoginHttp.action(deps, request({ action: "start", colorScheme: "light" }));
  expect(start.status).toBe(200);
  expect(start.headers.get("cache-control")).toBe("no-store");
  expect(await start.json()).toEqual({ stage: "starting" });
  expect((await LoginHttp.action(deps, request({ action: "poll" }))).status).toBe(200);
  expect((await LoginHttp.action(deps, request({ action: "stop" }))).status).toBe(204);
});

test("stream authorization permits only the browser owner while it runs", async () => {
  const { deps, login } = harness();
  const req = new Request(`${origin}/api/discord/login/authorize`);
  expect((await LoginHttp.authorize(deps, req)).status).toBe(403);
  (await login.start("123", "light")).unwrap();
  expect((await LoginHttp.authorize(deps, req)).status).toBe(204);
  const other = { ...deps, session: async () => Result.ok({ userId: "456" }) };
  expect((await LoginHttp.authorize(other, req)).status).toBe(403);
  await login.stop("123");
  expect((await LoginHttp.authorize(deps, req)).status).toBe(403);
});

test("internal reports require the launch secret, validate JSON and reject reports after stop", async () => {
  const h = harness();
  (await h.login.start("123", "light")).unwrap();
  const report = (secret: string | null, body: string) => LoginHttp.report(h.login, new Request("http://127.0.0.1:3100/api/internal/login-report", { method: "POST", headers: secret === null ? {} : { "x-login-secret": secret }, body }));
  for (const secret of [null, "wrong-secret"]) expect((await report(secret, '{}')).status).toBe(403);
  expect((await report(h.secret(), '{')).status).toBe(400);
  expect((await report(h.secret(), JSON.stringify({ kind: "qr", url: "https://evil.test" }))).status).toBe(400);
  expect((await report(h.secret(), JSON.stringify({ kind: "qr", url: "https://discord.com/ra/test-123" }))).status).toBe(204);
  await h.login.stop("123");
  expect((await report(h.secret(), '{}')).status).toBe(403);
});
