import { Result } from "better-result";
import { getDb } from "@/lib/db/client";
import { DiscordAccountLease } from "@/lib/discord/account-lease";
import { DiscordAccountStore } from "@/lib/discord/account-store";
import { DiscordRest } from "@/lib/discord/rest";
import { DiscordUser } from "@/lib/discord/user";
import { BrowserProcess } from "./browser-process";
import { LoginBrowser } from "./login-browser";

const key = Symbol.for("discord-mcp.login-browser");
type LoginGlobal = typeof globalThis & { [key]?: LoginBrowser };

const get = (): LoginBrowser => {
  const global: LoginGlobal = globalThis;
  global[key] ??= LoginBrowser.create({
    launch: BrowserProcess.fromEnv(),
    verify: async (token) => {
      // A failed new login must not mark the previous stored account as rejected.
      const rest = DiscordRest.create(token, { fetch: (url, init) => fetch(url, init), rejected: async () => Result.ok(undefined) });
      const verified = await rest.request("verify the Discord login", "/users/@me", DiscordUser.ApiSchema);
      if (verified.isErr()) return verified;
      const user = DiscordUser.fromApi(verified.value);
      return user === null ? Result.err({ message: "Discord returned an unreadable account profile. Nothing was saved; try again." }) : Result.ok(user);
    },
    save: (userId, login, signal) => DiscordAccountLease.run(userId, async () => {
      if (signal.aborted) return Result.err({ message: "The Discord login was stopped before saving. Stored accounts were not changed." });
      return DiscordAccountStore.save(getDb(), userId, login);
    }),
    now: Date.now,
    idleMs: 15 * 60_000,
    unknownMs: LoginBrowser.UNKNOWN_GRACE_MS,
  });
  return global[key];
};
export const LoginBrowserRuntime = { get } as const;
