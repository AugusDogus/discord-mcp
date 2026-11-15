import { Result, TaggedError } from "better-result";
import { LoginReport } from "../../src/lib/login-browser/report";

class LoginExtensionError extends TaggedError("LoginExtensionError")<{ message: string }> {}

const token = (raw: string | null): Result<string, LoginExtensionError> => {
  if (raw === null) return Result.err(new LoginExtensionError({ message: "Discord has not stored a token in this browser." }));
  const parsed = Result.try({ try: (): unknown => JSON.parse(raw), catch: () => new LoginExtensionError({ message: "Discord's stored token was not a JSON string." }) });
  if (parsed.isErr()) return parsed;
  const report = LoginReport.Schema.safeParse({ kind: "token", token: parsed.value });
  return report.success && report.data.kind === "token"
    ? Result.ok(report.data.token)
    : Result.err(new LoginExtensionError({ message: "Discord's stored token was not a nonempty string." }));
};

const isChannels = (pathname: string): boolean => pathname === "/channels" || pathname.startsWith("/channels/");
const isLogin = (pathname: string): boolean => pathname === "/login" || pathname.startsWith("/login/");
const isPhoneConfirmation = (text: string): boolean => /check your phone|confirm (?:the |your )?login|approve (?:the |your )?login/i.test(text);
const scanned = (name: string | null, avatarUrl: string | null): LoginReport | null => {
  const parsed = LoginReport.Schema.safeParse({ kind: "scanned", name, avatarUrl });
  return parsed.success ? parsed.data : null;
};
const isSender = (id: string | undefined, ownId: string, frameId: number | undefined, url: string | undefined): boolean => {
  if (id !== ownId || frameId !== 0 || url === undefined) return false;
  const parsed = Result.try({ try: () => new URL(url), catch: () => null });
  if (parsed.isErr()) return false;
  return parsed.value.origin === "https://discord.com" && (isLogin(parsed.value.pathname) || isChannels(parsed.value.pathname));
};
export const LoginParsing = { token, isChannels, isLogin, isPhoneConfirmation, scanned, isSender } as const;
