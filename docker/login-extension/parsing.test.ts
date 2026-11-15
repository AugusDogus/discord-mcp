import { expect, test } from "bun:test";
import { LoginParsing } from "./parsing";

test("stored token must be a JSON string; errors never echo its contents", () => {
  expect(LoginParsing.token('"test-token-not-real"').unwrap()).toBe("test-token-not-real");
  for (const raw of [null, "", "test-token-not-real", "null", "42", "{}", '""', '"with spaces"']) {
    const result = LoginParsing.token(raw);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).not.toContain("test-token-not-real");
  }
});

test("only top-frame extension senders on Discord login or channels are accepted", () => {
  expect(LoginParsing.isSender("test-id", "test-id", 0, "https://discord.com/login?redirect_to=%2Fchannels%2F%40me")).toBe(true);
  expect(LoginParsing.isSender("test-id", "test-id", 0, "https://discord.com/channels/@me")).toBe(true);
  for (const url of [undefined, "https://discord.com.evil.test/login", "http://discord.com/login", "https://discord.com/login-stolen", "https://evil.test/channels/@me", "not-a-url"]) expect(LoginParsing.isSender("test-id", "test-id", 0, url)).toBe(false);
  expect(LoginParsing.isSender("other-id", "test-id", 0, "https://discord.com/login")).toBe(false);
  expect(LoginParsing.isSender("test-id", "test-id", 1, "https://discord.com/login")).toBe(false);
});

test("phone confirmation names are plain text and avatars must be on Discord's CDN", () => {
  expect(LoginParsing.isPhoneConfirmation("Check your phone!")).toBe(true);
  expect(LoginParsing.isPhoneConfirmation("Log in with QR Code")).toBe(false);
  expect(LoginParsing.scanned(" Test User ", "https://cdn.discordapp.com/embed/avatars/0.png")).toMatchObject({ kind: "scanned", name: "Test User" });
  expect(LoginParsing.scanned("Test User", "https://evil.test/avatar.png")).toBe(null);
  expect(LoginParsing.scanned("", "https://cdn.discordapp.com/embed/avatars/0.png")).toBe(null);
});
