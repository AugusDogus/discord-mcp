import { TaggedError } from "better-result";

export class LoginBrowserError extends TaggedError("LoginBrowserError")<{
  reason: "busy" | "launch" | "cleanup" | "report" | "secret" | "verify" | "save";
  message: string;
}> {}
