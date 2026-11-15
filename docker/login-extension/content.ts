import type { LoginReport } from "../../src/lib/login-browser/report";
import { type ElementLayout, LoginParsing } from "./parsing";
import { LoginQr } from "./qr";

let busy = false;
let tokenSent = false;

const layoutOf = (element: Element): ElementLayout => {
  const style = getComputedStyle(element);
  const opacities: string[] = [];
  for (let node: Element | null = element; node !== null; node = node.parentElement) opacities.push(getComputedStyle(node).opacity);
  return {
    rect: element.getBoundingClientRect(),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    visibility: style.visibility,
    display: style.display,
    opacities,
  };
};

// Only a rendered captcha frame counts. Discord's form and the provider's
// hidden or off-screen frames appear before the challenge does.
const hasCaptcha = (): boolean => [...document.querySelectorAll("iframe")].some((frame) => LoginParsing.isCaptchaFrame(frame.src) && LoginParsing.isShown(layoutOf(frame)));

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
