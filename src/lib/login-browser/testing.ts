import { Result } from "better-result";
import type { BrowserHandle } from "./browser-process";
import { LoginBrowser, type LoginBrowserDeps } from "./login-browser";
import type { DiscordUser } from "@/lib/discord/user";

export const TEST_USER: DiscordUser = { id: "123", username: "test-user", globalName: "Test User", discriminator: "0", avatar: null };
export const createHarness = (overrides: Partial<LoginBrowserDeps> = {}) => {
  let secret = "";
  let now = 0;
  let done = false;
  let closed = 0;
  let resolveExit = () => {};
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  const exit = () => { done = true; resolveExit(); };
  const browser: BrowserHandle = {
    exited,
    hasExited: () => done,
    close: async () => { closed++; exit(); return Result.ok(undefined); },
  };
  const operations: string[] = [];
  const deps: LoginBrowserDeps = {
    launch: async (value) => { secret = value; operations.push("launch"); return Result.ok(browser); },
    verify: async () => { operations.push("verify"); return Result.ok(TEST_USER); },
    save: async () => { operations.push("save"); return Result.ok(undefined); },
    now: () => now,
    idleMs: 60_000,
    unknownMs: LoginBrowser.UNKNOWN_GRACE_MS,
    ...overrides,
  };
  const login = LoginBrowser.create(deps);
  return { login, deps, secret: () => secret, advance: (ms: number) => { now += ms; }, exit, closed: () => closed, operations };
};
