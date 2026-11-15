import type { LoginReport } from "../../src/lib/login-browser/report";
import { LoginParsing } from "./parsing";
import { LoginQr } from "./qr";

let busy = false;
let tokenSent = false;

const hasCaptcha = (): boolean => [...document.querySelectorAll('iframe, [class*="captcha"], [data-hcaptcha-widget-id]')].some((element) => {
  if (!LoginQr.visible(element)) return false;
  return !(element instanceof HTMLIFrameElement) || /hcaptcha\.com|recaptcha|captcha/i.test(element.src + element.title);
});

const scanned = (): LoginReport | null => {
  // Discord's CSS module suffixes vary. Limit name/avatar selectors to the QR
  // confirmation panel, and require its human-readable phone prompt as well.
  const panel = document.querySelector('[class*="qrLogin"], [class*="qrCodeContainer"]') ?? document.querySelector("form");
  if (panel === null || !LoginParsing.isPhoneConfirmation(panel.textContent ?? "")) return null;
  const name = panel.querySelector('[class*="username"], [class*="displayName"], [class*="userName"]')?.textContent?.trim() ?? null;
  const avatar = panel.querySelector('img[class*="avatar"], [class*="avatar"] img, [class*="avatar"]');
  const source = avatar instanceof HTMLImageElement ? avatar.src : avatar === null ? null : getComputedStyle(avatar).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1] ?? null;
  return LoginParsing.scanned(name, source);
};

const inspect = async (): Promise<LoginReport> => {
  if (hasCaptcha()) return { kind: "captcha" };
  const loginGone = !LoginParsing.isLogin(location.pathname) && document.querySelector('input[type="password"]') === null;
  if (LoginParsing.isChannels(location.pathname) || loginGone) {
    // Isolated world: Discord deleting window.localStorage in the page's main
    // world does not delete this world's accessor. Never send it to the page.
    const token = LoginParsing.token(globalThis.localStorage.getItem("token"));
    if (token.isOk()) return { kind: "token", token: token.value };
  }
  const confirmation = scanned();
  if (confirmation !== null) return confirmation;
  const url = await LoginQr.read();
  return url === null ? { kind: "unknown" } : { kind: "qr", url };
};

const report = async () => {
  if (busy || tokenSent) return;
  busy = true;
  try {
    const value = await inspect();
    if (value.kind === "token") tokenSent = true;
    await chrome.runtime.sendMessage(value);
  } catch {
    // Do not log exceptions from credential-bearing operations. Unknown state
    // also gives the owner access to the stream if storage or selectors fail.
    await chrome.runtime.sendMessage({ kind: "unknown" }).catch(() => undefined);
  } finally { busy = false; }
};
void report();
setInterval(() => { void report(); }, 1_000);
