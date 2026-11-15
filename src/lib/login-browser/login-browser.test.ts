import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { discordAccount } from "@/lib/db/app-schema";
import { DiscordAccountStore } from "@/lib/discord/account-store";
import { DiscordRest } from "@/lib/discord/rest";
import { DiscordUser } from "@/lib/discord/user";
import { VaultTesting } from "@/lib/vault/testing";
import { BrowserProcess } from "./browser-process";
import { createHarness, TEST_USER } from "./testing";

const qr = { kind: "qr", url: "https://discord.com/ra/test_QR-123" };
const scanned = { kind: "scanned", name: "Test User", avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" };
const token = { kind: "token", token: "test-token-not-real" };

describe("Discord browser login", () => {
  test("QR, scan and verified token finish in order, close the browser and consume the secret", async () => {
    const h = createHarness();
    expect((await h.login.start("123", "dark")).unwrap()).toEqual({ stage: "starting" });
    expect(h.login.canView("123")).toBe(true);
    expect(h.login.canView("456")).toBe(false);
    (await h.login.report(h.secret(), qr)).unwrap();
    expect(await h.login.poll("123")).toEqual({ stage: "qr", url: qr.url });
    (await h.login.report(h.secret(), scanned)).unwrap();
    expect(await h.login.poll("123")).toEqual({ stage: "scanned", user: { name: scanned.name, avatarUrl: scanned.avatarUrl } });
    (await h.login.report(h.secret(), token)).unwrap();
    expect(h.operations).toEqual(["launch", "verify", "save"]);
    expect(await h.login.poll("123")).toEqual({ stage: "loggedIn" });
    expect(h.closed()).toBe(1);
    expect(h.login.canView("123")).toBe(false);
    expect((await h.login.report(h.secret(), token)).isErr()).toBe(true);
    expect(JSON.stringify(await h.login.poll("123"))).not.toContain(token.token);
  });

  test("captcha immediately shows the stream and unknown or missing reports do so after five seconds", async () => {
    const h = createHarness();
    (await h.login.start("123", "light")).unwrap();
    (await h.login.report(h.secret(), qr)).unwrap();
    (await h.login.report(h.secret(), { kind: "unknown" })).unwrap();
    expect(await h.login.poll("123")).toMatchObject({ stage: "qr" });
    h.advance(5_001);
    expect(await h.login.poll("123")).toEqual({ stage: "browser" });
    (await h.login.report(h.secret(), scanned)).unwrap();
    (await h.login.report(h.secret(), { kind: "captcha" })).unwrap();
    expect(await h.login.poll("123")).toEqual({ stage: "browser" });
    (await h.login.report(h.secret(), token)).unwrap();
    expect(await h.login.poll("123")).toEqual({ stage: "loggedIn" });
  });

  test("repeated classified reports keep a valid QR visible", async () => {
    const h = createHarness();
    (await h.login.start("123", "light")).unwrap();
    h.advance(4_000);
    (await h.login.report(h.secret(), qr)).unwrap();
    h.advance(4_000);
    expect(await h.login.poll("123")).toMatchObject({ stage: "qr" });
    await h.login.stop("123");
  });

  test("rejects foreign QR and avatar URLs without changing the view", async () => {
    const h = createHarness();
    (await h.login.start("123", "light")).unwrap();
    for (const url of ["https://evil.test/ra/test", "https://discord.com.evil.test/ra/test", "https://discord.com/ra/test?token=123", "http://discord.com/ra/test", "https://discord.com/ra/test/extra"]) {
      expect((await h.login.report(h.secret(), { ...qr, url })).isErr()).toBe(true);
    }
    for (const avatarUrl of ["https://evil.test/a.png", "https://cdn.discordapp.com.evil.test/a.png", "https://user@cdn.discordapp.com/a.png", "http://cdn.discordapp.com/a.png"]) {
      expect((await h.login.report(h.secret(), { ...scanned, avatarUrl })).isErr()).toBe(true);
    }
    expect(await h.login.poll("123")).toEqual({ stage: "starting" });
    await h.login.stop("123");
  });

  test("rejects wrong, missing and stale secrets, and reports from an exited browser", async () => {
    const h = createHarness();
    (await h.login.start("123", "light")).unwrap();
    for (const secret of [null, "", "wrong-secret"]) expect((await h.login.report(secret, qr)).isErr()).toBe(true);
    h.exit();
    expect(h.login.accepts(h.secret())).toBe(false);
    expect((await h.login.report(h.secret(), token)).isErr()).toBe(true);
    expect(await h.login.poll("123")).toMatchObject({ stage: "error" });
    expect(h.operations).toEqual(["launch"]);
  });

  test("a browser is exclusive to its owner and starting twice reuses it", async () => {
    const h = createHarness();
    (await h.login.start("123", "light")).unwrap();
    (await h.login.start("123", "dark")).unwrap();
    expect((await h.login.start("456", "light")).match({ ok: () => null, err: (e) => e.reason })).toBe("busy");
    expect(h.operations).toEqual(["launch"]);
    await h.login.stop("456");
    expect(h.login.canView("123")).toBe(true);
    expect(await h.login.poll("456")).toMatchObject({ stage: "error" });
    await h.login.stop("123");
    expect((await h.login.report(h.secret(), token)).isErr()).toBe(true);
  });

  test("401 during verification is an error and does not save the token", async () => {
    const rest = DiscordRest.create(token.token, { fetch: async () => new Response(null, { status: 401 }), rejected: async () => Result.ok(undefined) });
    const h = createHarness({ verify: async () => {
      const result = await rest.request("verify the Discord login", "/users/@me", DiscordUser.ApiSchema);
      return result.isErr() ? result : Result.ok(TEST_USER);
    } });
    (await h.login.start("123", "light")).unwrap();
    expect((await h.login.report(h.secret(), token)).isErr()).toBe(true);
    expect(await h.login.poll("123")).toMatchObject({ stage: "error" });
    expect(h.operations).toEqual(["launch"]);
    expect(h.closed()).toBe(1);
  });

  test("cancelling during verification prevents a late save", async () => {
    let resolveVerify = () => {};
    const gate = new Promise<void>((resolve) => { resolveVerify = resolve; });
    const h = createHarness({ verify: async () => { await gate; return Result.ok(TEST_USER); } });
    (await h.login.start("123", "light")).unwrap();
    const reporting = h.login.report(h.secret(), token);
    await Promise.resolve();
    const stopping = h.login.stop("123");
    resolveVerify();
    expect((await reporting).isErr()).toBe(true);
    await stopping;
    expect(h.operations).toEqual(["launch"]);
    expect(h.login.canView("123")).toBe(false);
  });

  test("an abandoned browser times out and rejects later reports", async () => {
    const h = createHarness({ idleMs: 10 });
    (await h.login.start("123", "light")).unwrap();
    await Bun.sleep(30);
    expect(await h.login.poll("123")).toMatchObject({ stage: "error" });
    expect(h.closed()).toBe(1);
    expect((await h.login.report(h.secret(), token)).isErr()).toBe(true);
  });

  test("verifies /users/@me using the existing REST client, then stores a sealed token", async () => {
    const database = await VaultTesting.createDb();
    try {
      const userId = await VaultTesting.createUser(database.db);
      const config = VaultTesting.vaultConfig();
      const h = createHarness({
        verify: async (captured) => {
          const rest = DiscordRest.create(captured, {
            fetch: async (url, init) => {
              expect(url).toBe("https://discord.com/api/v9/users/@me");
              expect(init.method).toBe("GET");
              expect(new Headers(init.headers).get("authorization")).toBe(token.token);
              return Response.json({ id: "123", username: "test-user", global_name: "Test User", discriminator: "0", avatar: null });
            },
            rejected: async () => Result.ok(undefined),
          });
          const result = await rest.request("verify the Discord login", "/users/@me", DiscordUser.ApiSchema);
          if (result.isErr()) return result;
          expect(await database.db.select().from(discordAccount)).toHaveLength(0);
          return Result.ok(TEST_USER);
        },
        save: async (id, login) => DiscordAccountStore.saveWith(database.db, config, id, login),
      });
      (await h.login.start(userId, "light")).unwrap();
      (await h.login.report(h.secret(), token)).unwrap();
      const rows = await database.db.select().from(discordAccount);
      expect(rows[0]?.tokenEnc.startsWith("d1.")).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(token.token);
      expect((await DiscordAccountStore.credentialsWith(database.db, config, userId)).unwrap()?.token).toBe(token.token);
    } finally { database.cleanup(); }
  });
});

test("Chromium uses RAM profile, extension, Wayland and explicit color scheme without debugging or fingerprint overrides", () => {
  const args = BrowserProcess.args("/dev/shm/test-profile", "/dev/shm/test-extension", "dark");
  expect(args).toContain("--password-store=basic");
  expect(args).toContain("--ozone-platform=wayland");
  expect(args).toContain("--load-extension=/dev/shm/test-extension");
  expect(args).toContain("--disable-extensions-except=/dev/shm/test-extension");
  expect(args).toContain("--force-dark-mode");
  expect(args.some((arg) => arg.includes("remote-debugging") || arg.includes("user-agent"))).toBe(false);
  expect(args.at(-1)).toBe("https://discord.com/login");
  expect(BrowserProcess.args("/dev/shm/test-profile", "/dev/shm/test-extension", "light")).toContain("--blink-settings=preferredColorScheme=1");
});
