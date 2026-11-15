import type { Result } from "better-result";
import { getDb } from "@/lib/db/client";
import { DiscordAccountStore } from "./account-store";
import {
  RemoteAuth,
  type RemoteAuthError,
  type RemoteAuthOutcome,
  type RemoteAuthProgress,
  type RemoteAuthRunOptions,
} from "./remote-auth";
import { DiscordUser } from "./user";

/**
 * The QR login the dashboard shows, kept in server memory per signed-in
 * user: at most one remote-auth run per user, restarted with a fresh code
 * whenever one expires or is cancelled on the phone, and stopped when the
 * page stops asking (closed tab) or the login is saved. The dashboard polls
 * `poll` about once a second.
 */

export type LoginView =
  | { readonly stage: "starting" }
  | { readonly stage: "qr"; readonly url: string; readonly expiresAt: number }
  | {
      readonly stage: "scanned";
      readonly user: { readonly name: string; readonly handle: string; readonly avatarUrl: string };
    }
  | { readonly stage: "loggedIn" }
  | { readonly stage: "error"; readonly message: string };

export type LoginSessionDeps = {
  /** One QR code's run, from connecting to its outcome (RemoteAuth.run in production). */
  readonly runAuth: (options: RemoteAuthRunOptions) => Promise<Result<RemoteAuthOutcome, RemoteAuthError>>;
  /** Persists a finished login (seals the token). */
  readonly save: (
    userId: string,
    login: { readonly token: string; readonly user: DiscordUser },
  ) => Promise<Result<unknown, { readonly _tag: string; readonly message: string }>>;
  /** Whether the user already has a usable login, so a late poll does not start a new QR. */
  readonly isLoggedIn: (userId: string) => Promise<boolean>;
  readonly now: () => number;
  /** Stop when nobody polled for this long. */
  readonly idleMs: number;
  /** Codes that end this soon after they appear count as a failing gateway, not an expiry. */
  readonly quickEndMs: number;
};

type Entry = {
  view: LoginView;
  lastPolledAt: number;
  readonly controller: AbortController;
  readonly idleCheck: ReturnType<typeof setInterval>;
};

const MAX_QUICK_ENDS = 3;

const viewFor = (progress: RemoteAuthProgress): LoginView =>
  progress.kind === "qr"
    ? { stage: "qr", url: progress.url, expiresAt: progress.expiresAt }
    : {
        stage: "scanned",
        user: {
          name: DiscordUser.displayName(progress.user),
          handle: DiscordUser.handle(progress.user),
          avatarUrl: DiscordUser.avatarUrl(progress.user),
        },
      };

export const createLoginSessions = (deps: LoginSessionDeps) => {
  const entries = new Map<string, Entry>();

  const stop = (userId: string): void => {
    const entry = entries.get(userId);
    if (!entry) return;
    entries.delete(userId);
    clearInterval(entry.idleCheck);
    entry.controller.abort();
  };

  const settle = (userId: string, entry: Entry, view: LoginView) => {
    entry.view = view;
    clearInterval(entry.idleCheck);
    entry.controller.abort();
    // Keep the final view until the page reads it, then forget it.
    setTimeout(() => {
      if (entries.get(userId) === entry) entries.delete(userId);
    }, deps.idleMs).unref?.();
  };

  /** Runs QR codes back to back until one logs in, fails, or the entry is stopped. */
  const loop = async (userId: string, entry: Entry) => {
    const { signal } = entry.controller;
    let quickEnds = 0;
    while (!signal.aborted) {
      let shownAt: number | null = null;
      const result = await deps.runAuth({
        signal,
        onProgress: (progress) => {
          if (signal.aborted) return;
          if (progress.kind === "qr") shownAt = deps.now();
          entry.view = viewFor(progress);
        },
      });
      if (signal.aborted) return;
      if (result.isErr()) {
        console.error(`[discord:login] ${result.error._tag} user=${userId}`);
        return settle(userId, entry, { stage: "error", message: result.error.message });
      }
      const outcome = result.value;
      switch (outcome.kind) {
        case "aborted":
          return;
        case "loggedIn": {
          const saved = await deps.save(userId, { token: outcome.token, user: outcome.user });
          if (saved.isErr()) {
            console.error(`[discord:login] saving failed: ${saved.error._tag} user=${userId}`);
            return settle(userId, entry, { stage: "error", message: saved.error.message });
          }
          return settle(userId, entry, { stage: "loggedIn" });
        }
        case "cancelled":
        case "expired": {
          // A fresh code, silently. A gateway that ends every code at once is failing.
          quickEnds = shownAt === null || deps.now() - shownAt < deps.quickEndMs ? quickEnds + 1 : 0;
          if (quickEnds >= MAX_QUICK_ENDS) {
            return settle(userId, entry, {
              stage: "error",
              message: "Discord's login service keeps ending the code right away. Nothing was saved; try again in a minute.",
            });
          }
          entry.view = { stage: "starting" };
        }
      }
    }
  };

  const start = (userId: string): Entry => {
    stop(userId);
    const entry: Entry = {
      view: { stage: "starting" },
      lastPolledAt: deps.now(),
      controller: new AbortController(),
      idleCheck: setInterval(() => {
        if (deps.now() - entry.lastPolledAt > deps.idleMs) stop(userId);
      }, Math.max(10, Math.floor(deps.idleMs / 4))),
    };
    entry.idleCheck.unref?.();
    entries.set(userId, entry);
    void loop(userId, entry);
    return entry;
  };

  /** The current view, starting a login when none runs (and the user is not logged in). */
  const poll = async (userId: string): Promise<LoginView> => {
    const existing = entries.get(userId);
    if (existing) {
      existing.lastPolledAt = deps.now();
      return existing.view;
    }
    if (await deps.isLoggedIn(userId)) return { stage: "loggedIn" };
    if (entries.has(userId)) return poll(userId);
    return start(userId).view;
  };

  /** Starts over with a fresh code (after an error). */
  const restart = (userId: string): LoginView => start(userId).view;

  return { poll, restart, stop, activeCount: () => entries.size } as const;
};

export type LoginSessions = ReturnType<typeof createLoginSessions>;

const liveDeps = (): LoginSessionDeps => ({
  runAuth: (options) => RemoteAuth.run(RemoteAuth.liveDeps(), options),
  save: (userId, login) => DiscordAccountStore.save(getDb(), userId, login),
  isLoggedIn: async (userId) => {
    const credentials = await DiscordAccountStore.credentials(getDb(), userId);
    return credentials.isOk() && credentials.value !== null && credentials.value.record.status === "active";
  },
  now: () => Date.now(),
  idleMs: 20_000,
  quickEndMs: 3_000,
});

/** One manager per server process; survives dev hot reloads. */
const globalKey = Symbol.for("discord-mcp.login-sessions");
type GlobalWithSessions = typeof globalThis & { [globalKey]?: LoginSessions };

export const DiscordLogin = {
  sessions: (): LoginSessions => {
    const global: GlobalWithSessions = globalThis;
    global[globalKey] ??= createLoginSessions(liveDeps());
    return global[globalKey];
  },
} as const;
