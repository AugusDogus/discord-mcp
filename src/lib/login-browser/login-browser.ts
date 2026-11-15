import { randomBytes, timingSafeEqual } from "node:crypto";
import { Result } from "better-result";
import type { DiscordUser } from "@/lib/discord/user";
import type { BrowserHandle, BrowserLauncher, ColorScheme } from "./browser-process";
import { LoginBrowserError } from "./error";
import type { LoginView } from "./login-view";
import { LoginReport } from "./report";

export type LoginBrowserDeps = {
  readonly launch: BrowserLauncher;
  readonly verify: (token: string) => Promise<Result<DiscordUser, { readonly message: string }>>;
  readonly save: (userId: string, login: { readonly token: string; readonly user: DiscordUser }, signal: AbortSignal) => Promise<Result<unknown, { readonly message: string }>>;
  readonly now: () => number;
  readonly idleMs: number;
  /** How long no QR, scan or captcha may be seen before the live browser is shown. */
  readonly unknownMs: number;
};

/**
 * Discord passes through unrecognized screens between QR, confirmation and
 * login. Wait this long before showing the stream for them; a visible captcha
 * shows it at once.
 */
const UNKNOWN_GRACE_MS = 15_000;

type Active = {
  readonly userId: string;
  readonly browser: BrowserHandle;
  readonly controller: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  view: LoginView;
  lastClassifiedAt: number;
};
type State =
  | { readonly kind: "idle" }
  | (Active & { readonly kind: "running"; readonly secret: string })
  | (Active & { readonly kind: "closing" })
  | { readonly kind: "settled"; readonly userId: string; readonly view: LoginView; readonly expiresAt: number };

const create = (deps: LoginBrowserDeps) => {
  let state: State = { kind: "idle" };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op, op);
    queue = next.catch(() => undefined);
    return next;
  };
  const active = (): Active | null => state.kind === "running" || state.kind === "closing" ? state : null;
  const accepts = (secret: string | null): boolean => {
    if (state.kind !== "running" || state.controller.signal.aborted || state.browser.hasExited() || secret === null) return false;
    const supplied = Buffer.from(secret);
    const expected = Buffer.from(state.secret);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const finish = async (current: Active, view: LoginView): Promise<Result<void, LoginBrowserError>> => {
    clearTimeout(current.timer);
    current.controller.abort();
    // Drop the secret before waiting on Chromium or filesystem cleanup.
    state = { ...current, kind: "closing", view };
    const closed = await current.browser.close();
    if (closed.isErr()) {
      state = { ...current, kind: "closing", view: { stage: "error", message: closed.error.message } };
      return closed;
    }
    state = { kind: "settled", userId: current.userId, view, expiresAt: deps.now() + deps.idleMs };
    return Result.ok(undefined);
  };
  const fail = async (current: Active, error: LoginBrowserError) => {
    const closed = await finish(current, { stage: "error", message: error.message });
    return closed.isErr() ? closed : Result.err(error);
  };
  const stop = (userId: string): Promise<Result<void, LoginBrowserError>> => {
    // Invalidate synchronously, including a token save waiting on the account lease.
    const current = active();
    if (current?.userId === userId) current.controller.abort();
    return serial(async () => {
      const current = active();
      if (current?.userId === userId) return finish(current, { stage: "error", message: "The Discord login was cancelled. Try again to open a fresh browser." });
      return Result.ok(undefined);
    });
  };
  return {
    start: (userId: string, colorScheme: ColorScheme): Promise<Result<LoginView, LoginBrowserError>> => serial(async () => {
      const current = active();
      if (current !== null) {
        if (current.userId !== userId) return Result.err(new LoginBrowserError({ reason: "busy", message: "Another user is logging in to Discord in the browser. Wait for them to finish, then try again." }));
        if (state.kind === "running" && !current.controller.signal.aborted && !current.browser.hasExited()) return Result.ok(current.view);
        const closed = await finish(current, current.view);
        if (closed.isErr()) return closed;
      }
      const secret = randomBytes(32).toString("hex");
      const launched = await deps.launch(secret, colorScheme);
      if (launched.isErr()) return launched;
      const browser = launched.value;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
        void serial(async () => {
          const current = active();
          if (current?.browser === browser) await finish(current, { stage: "error", message: "The Discord login browser closed after 15 minutes. Nothing was saved; try again." });
        });
      }, deps.idleMs);
      timer.unref?.();
      state = { kind: "running", userId, secret, browser, controller, timer, view: { stage: "starting" }, lastClassifiedAt: deps.now() };
      void browser.exited.then(() => serial(async () => {
        if (state.kind === "running" && state.browser === browser) await finish(state, { stage: "error", message: "The Discord login browser closed before login finished. Nothing was saved; try again." });
      }));
      return Result.ok(state.view);
    }),
    poll: (userId: string): Promise<LoginView> => serial(async () => {
      if (state.kind === "settled" && state.expiresAt <= deps.now()) state = { kind: "idle" };
      if (state.kind === "idle" || state.userId !== userId) return { stage: "error", message: "The login browser is no longer open. Try again to start a fresh login." };
      if (state.kind === "running" && deps.now() - state.lastClassifiedAt >= deps.unknownMs) state.view = { stage: "browser", reason: "unknown" };
      return state.view;
    }),
    stop,
    canView: (userId: string): boolean => state.kind === "running" && state.userId === userId && !state.controller.signal.aborted && !state.browser.hasExited(),
    accepts,
    report: (secret: string | null, value: unknown): Promise<Result<void, LoginBrowserError>> => serial(async () => {
      if (!accepts(secret) || state.kind !== "running") return Result.err(new LoginBrowserError({ reason: "secret", message: "This login browser report is not authorized or its browser has closed." }));
      const parsed = LoginReport.Schema.safeParse(value);
      if (!parsed.success) return Result.err(new LoginBrowserError({ reason: "report", message: "The login browser report was invalid. No login state was changed." }));
      const report = parsed.data;
      const current = state;
      switch (report.kind) {
        case "qr":
          current.lastClassifiedAt = deps.now();
          current.view = { stage: "qr", url: report.url };
          return Result.ok(undefined);
        case "scanned":
          current.lastClassifiedAt = deps.now();
          current.view = { stage: "scanned", user: { name: report.name, avatarUrl: report.avatarUrl } };
          return Result.ok(undefined);
        case "captcha":
          current.lastClassifiedAt = deps.now();
          current.view = { stage: "browser", reason: "captcha" };
          return Result.ok(undefined);
        case "unknown":
          if (deps.now() - current.lastClassifiedAt >= deps.unknownMs) current.view = { stage: "browser", reason: "unknown" };
          return Result.ok(undefined);
        case "token": {
          // The one-time secret cannot submit a second token, even during verification.
          state = { ...current, kind: "closing" };
          const verified = await deps.verify(report.token);
          if (current.controller.signal.aborted) return fail(current, new LoginBrowserError({ reason: "save", message: "The Discord login was cancelled before saving. The previous stored account was kept." }));
          if (verified.isErr()) return fail(current, new LoginBrowserError({ reason: "verify", message: verified.error.message }));
          const saved = await deps.save(current.userId, { token: report.token, user: verified.value }, current.controller.signal);
          if (saved.isErr()) return fail(current, new LoginBrowserError({ reason: "save", message: saved.error.message }));
          return finish(current, { stage: "loggedIn" });
        }
      }
    }),
  } as const;
};
export type LoginBrowser = ReturnType<typeof create>;
export const LoginBrowser = { create, UNKNOWN_GRACE_MS } as const;
