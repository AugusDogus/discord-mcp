import { expect, test } from "bun:test";
import { Result } from "better-result";
import { DiscordPresence } from "./presence";
import type { GatewayStatus } from "./gateway";
import { DiscordRest } from "./rest";

const harness = () => {
  let now = 0;
  const statuses: GatewayStatus[] = [];
  const closes: string[] = [];
  let connects = 0;
  const manager = DiscordPresence.create({
    now: () => now,
    idleMs: 120_000,
    onlineMs: 180_000,
    connect: async (token, status, signal) => {
      connects++;
      statuses.push(status);
      signal.addEventListener("abort", () => closes.push(token), { once: true });
      return Result.ok({
        sessionId: "test-session",
        alive: () => !signal.aborted,
        setStatus: (next) => {
          statuses.push(next);
        },
        close: () => {},
      });
    },
  });
  return {
    manager,
    statuses,
    closes,
    connects: () => connects,
    advance: (ms: number) => {
      now += ms;
      manager.sweep();
    },
  };
};
test("no session exists until an interaction; default sessions identify invisible and expire after two idle minutes", async () => {
  const h = harness();
  expect(h.connects()).toBe(0);
  await h.manager.withSession("123", "test-token-not-real", false, async () => Result.ok("sent"));
  expect(h.statuses).toEqual(["invisible"]);
  h.advance(119_999);
  expect(h.manager.activeCount()).toBe(1);
  h.advance(1);
  expect(h.manager.activeCount()).toBe(0);
  expect(h.closes).toEqual(["test-token-not-real"]);
});
test("enabled writes hold online for three minutes, and stop closes immediately", async () => {
  const h = harness();
  await h.manager.withSession("123", "test-token-not-real", true, async () => Result.ok(null));
  expect(h.statuses).toEqual(["online"]);
  h.advance(120_000);
  expect(h.manager.activeCount()).toBe(1);
  h.advance(60_000);
  expect(h.manager.activeCount()).toBe(0);
  await h.manager.withSession("123", "test-token-not-real", true, async () => Result.ok(null));
  h.manager.stop("123");
  expect(h.manager.activeCount()).toBe(0);
});
test("activity resets the idle deadline and active operations cannot be swept", async () => {
  const h = harness();
  await h.manager.withSession("123", "test-token-not-real", false, async () => Result.ok(null));
  h.advance(100_000);
  await h.manager.withSession("123", "test-token-not-real", false, async () => {
    h.advance(150_000);
    expect(h.manager.activeCount()).toBe(1);
    return Result.ok(null);
  });
  expect(h.connects()).toBe(1);
  h.advance(120_000);
  expect(h.manager.activeCount()).toBe(0);
});
test("users are isolated; re-login replaces the old session; connect failures do not run the action", async () => {
  const h = harness();
  for (const id of ["123", "456"])
    await h.manager.withSession(id, "test-token-not-real", false, async () => Result.ok(null));
  await h.manager.withSession("123", "test-token-new-not-real", false, async () => Result.ok(null));
  expect(h.manager.activeCount()).toBe(2);
  expect(h.connects()).toBe(3);
  expect(h.closes).toHaveLength(1);
  h.manager.stop("123");
  h.manager.stop("456");
  let acted = false;
  const failed = DiscordPresence.create({
    now: () => 0,
    idleMs: 1,
    onlineMs: 1,
    connect: async () => Result.err(DiscordRest.error("connect", null, "Connection unavailable.")),
  });
  expect(
    (
      await failed.withSession("123", "test-token-not-real", false, async () => {
        acted = true;
        return Result.ok(null);
      })
    ).isErr(),
  ).toBe(true);
  expect(acted).toBe(false);
  expect(failed.activeCount()).toBe(0);
});
