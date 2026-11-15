import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { createLoginSessions, type LoginSessionDeps } from "./login-session";
import { RemoteAuthConnectionError, type RemoteAuthOutcome, type RemoteAuthRunOptions } from "./remote-auth";
import type { DiscordUser } from "./user";

const ALICE: DiscordUser = { id: "123", username: "alice", globalName: "Alice", discriminator: "0", avatar: null };

/** One scripted QR run: what it reports while it runs, then how it ends. */
type Script = {
  readonly progress?: ((options: RemoteAuthRunOptions) => void)[];
  readonly outcome: RemoteAuthOutcome | "error" | "hang";
};

/** Scripted runs, one per QR code, released one at a time with `step`. */
const harness = (overrides: Partial<LoginSessionDeps> = {}) => {
  const scripts: Script[] = [];
  let release: (() => void) | null = null;
  let now = 1_000;
  const saved: { userId: string; user: DiscordUser }[] = [];
  let runs = 0;

  const deps: LoginSessionDeps = {
    runAuth: async (options) => {
      runs += 1;
      const script = scripts.shift() ?? { outcome: "hang" };
      for (const report of script.progress ?? []) report(options);
      if (script.outcome === "hang") {
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve()));
        return Result.ok({ kind: "aborted" });
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (script.outcome === "error") {
        return Result.err(new RemoteAuthConnectionError({ closeCode: 1011, message: "Discord's login service closed the connection." }));
      }
      return Result.ok(script.outcome);
    },
    save: async (userId, login) => {
      saved.push({ userId, user: login.user });
      return Result.ok(undefined);
    },
    isLoggedIn: async () => false,
    now: () => now,
    idleMs: 60_000,
    quickEndMs: 3_000,
    ...overrides,
  };

  const sessions = createLoginSessions(deps);
  /** Let the current run finish, then let the session react. */
  const step = async () => {
    const current = release;
    release = null;
    current?.();
    await Bun.sleep(1);
  };
  return {
    sessions,
    scripts,
    saved,
    step,
    runs: () => runs,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const qr = (url: string) => (options: RemoteAuthRunOptions) =>
  options.onProgress({ kind: "qr", url, expiresAt: 999_999 });
const scanned = (options: RemoteAuthRunOptions) => options.onProgress({ kind: "scanned", user: ALICE });

describe("login sessions", () => {
  test("first poll starts a login; the page then sees the QR, the scanned user, and the finish", async () => {
    const h = harness();
    h.scripts.push({ progress: [qr("https://discord.com/ra/one"), scanned], outcome: { kind: "loggedIn", token: "test-token-not-real", user: ALICE } });

    await h.sessions.poll("u1");
    await Bun.sleep(1);
    const view = await h.sessions.poll("u1");
    expect(view).toMatchObject({ stage: "scanned", user: { name: "Alice", handle: "@alice" } });

    await h.step();
    expect(await h.sessions.poll("u1")).toEqual({ stage: "loggedIn" });
    expect(h.saved).toEqual([{ userId: "u1", user: ALICE }]);
  });

  test("an expired code is replaced by a fresh one without an error", async () => {
    const h = harness();
    h.scripts.push({ progress: [qr("https://discord.com/ra/one")], outcome: { kind: "expired" } });
    h.scripts.push({ progress: [qr("https://discord.com/ra/two")], outcome: "hang" });

    await h.sessions.poll("u1");
    await Bun.sleep(1);
    h.advance(120_000);
    await h.step();
    expect(await h.sessions.poll("u1")).toMatchObject({ stage: "qr", url: "https://discord.com/ra/two" });
    expect(h.runs()).toBe(2);
    h.sessions.stop("u1");
  });

  test("cancelling on the phone shows a fresh code too", async () => {
    const h = harness();
    h.scripts.push({ progress: [qr("https://discord.com/ra/one"), scanned], outcome: { kind: "cancelled" } });
    h.scripts.push({ progress: [qr("https://discord.com/ra/two")], outcome: "hang" });

    await h.sessions.poll("u1");
    await Bun.sleep(1);
    h.advance(10_000);
    await h.step();
    expect(await h.sessions.poll("u1")).toMatchObject({ stage: "qr", url: "https://discord.com/ra/two" });
    h.sessions.stop("u1");
  });

  test("codes that end right away three times in a row stop with an error", async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) h.scripts.push({ progress: [qr(`https://discord.com/ra/${i}`)], outcome: { kind: "expired" } });

    await h.sessions.poll("u1");
    for (let i = 0; i < 3; i += 1) {
      await Bun.sleep(1);
      await h.step();
    }
    const view = await h.sessions.poll("u1");
    expect(view.stage).toBe("error");
    expect(h.runs()).toBe(3);
  });

  test("a gateway failure ends in an error; restart begins a fresh login", async () => {
    const h = harness();
    h.scripts.push({ progress: [qr("https://discord.com/ra/one")], outcome: "error" });
    h.scripts.push({ progress: [qr("https://discord.com/ra/two")], outcome: "hang" });

    await h.sessions.poll("u1");
    await Bun.sleep(1);
    await h.step();
    expect(await h.sessions.poll("u1")).toMatchObject({ stage: "error" });

    h.sessions.restart("u1");
    await Bun.sleep(1);
    expect(await h.sessions.poll("u1")).toMatchObject({ stage: "qr", url: "https://discord.com/ra/two" });
    h.sessions.stop("u1");
  });

  test("an account that is already logged in gets no new code", async () => {
    const h = harness({ isLoggedIn: async () => true });
    expect(await h.sessions.poll("u1")).toEqual({ stage: "loggedIn" });
    expect(h.runs()).toBe(0);
  });

  test("users get separate logins, and stopping one leaves the other", async () => {
    const h = harness();
    h.scripts.push({ progress: [qr("https://discord.com/ra/a")], outcome: "hang" });
    h.scripts.push({ progress: [qr("https://discord.com/ra/b")], outcome: "hang" });

    await h.sessions.poll("u1");
    await h.sessions.poll("u2");
    await Bun.sleep(1);
    expect(h.sessions.activeCount()).toBe(2);

    h.sessions.stop("u1");
    expect(h.sessions.activeCount()).toBe(1);
    expect(await h.sessions.poll("u2")).toMatchObject({ stage: "qr", url: "https://discord.com/ra/b" });
    h.sessions.stop("u2");
  });

  test("a login nobody polls stops on its own", async () => {
    const h = harness({ idleMs: 40 });
    h.scripts.push({ progress: [qr("https://discord.com/ra/one")], outcome: "hang" });

    await h.sessions.poll("u1");
    h.advance(1_000);
    await Bun.sleep(60);
    expect(h.sessions.activeCount()).toBe(0);
  });
});
