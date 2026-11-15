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

test("only hCaptcha or reCAPTCHA frames over HTTPS count as captchas", () => {
  for (const src of [
    "https://newassets.hcaptcha.com/captcha/v1/test/static/hcaptcha.html#frame=checkbox",
    "https://hcaptcha.com/captcha",
    "https://www.google.com/recaptcha/api2/anchor",
    "https://www.recaptcha.net/recaptcha/api2/bframe",
  ]) expect(LoginParsing.isCaptchaFrame(src)).toBe(true);
  for (const src of ["", "about:blank", "http://newassets.hcaptcha.com/captcha", "https://hcaptcha.com.evil.test/captcha", "https://discord.com/login", "https://www.google.com/search?q=recaptcha", "https://evil.test/?hcaptcha.com"])
    expect(LoginParsing.isCaptchaFrame(src)).toBe(false);
});

test("a captcha is shown only with a size, visible styles, opacity and a place in the viewport", () => {
  const shown = {
    rect: { width: 300, height: 80, top: 200, left: 100, bottom: 280, right: 400 },
    viewport: { width: 1280, height: 720 },
    visibility: "visible",
    display: "block",
    opacities: ["1", "1", "1"],
  };
  expect(LoginParsing.isShown(shown)).toBe(true);
  expect(LoginParsing.isShown({ ...shown, rect: { ...shown.rect, width: 0, right: 100 } })).toBe(false);
  expect(LoginParsing.isShown({ ...shown, rect: { ...shown.rect, height: 0, bottom: 200 } })).toBe(false);
  expect(LoginParsing.isShown({ ...shown, visibility: "hidden" })).toBe(false);
  expect(LoginParsing.isShown({ ...shown, display: "none" })).toBe(false);
  expect(LoginParsing.isShown({ ...shown, opacities: ["1", "0", "1"] })).toBe(false);
  expect(LoginParsing.isShown({ ...shown, opacities: ["1", "0.5"] })).toBe(true);
  // hCaptcha parks its challenge frame off-screen until it is needed.
  expect(LoginParsing.isShown({ ...shown, rect: { width: 400, height: 600, top: -10_000, left: 100, bottom: -9_400, right: 500 } })).toBe(false);
  expect(LoginParsing.isShown({ ...shown, rect: { width: 400, height: 600, top: 100, left: 2_000, bottom: 700, right: 2_400 } })).toBe(false);
});
