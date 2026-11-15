import type { Result } from "better-result";
import { z } from "zod";
import { RequestGuard, type RequestRejectedError, type SignedInRequest } from "@/lib/http/request-guard";
import type { LoginBrowser } from "./login-browser";
import type { LoginBrowserError } from "./error";

export type LoginHttpDeps = {
  readonly origin: string;
  readonly session: (request: Request) => Promise<Result<SignedInRequest, RequestRejectedError>>;
  readonly browser: LoginBrowser;
};
const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), colorScheme: z.enum(["light", "dark"]) }),
  z.object({ action: z.literal("poll") }),
  z.object({ action: z.literal("stop") }),
]);
const noStore = (response: Response): Response => {
  response.headers.set("cache-control", "no-store");
  return response;
};
const error = (error: LoginBrowserError) => RequestGuard.errorResponse(
  error.reason === "busy" ? 409 : error.reason === "secret" ? 403 : error.reason === "report" ? 400 : 500,
  error.message,
);
const action = async (deps: LoginHttpDeps, request: Request): Promise<Response> => {
  if (!RequestGuard.isSameOrigin(request, deps.origin)) return RequestGuard.errorResponse(403, "Open the discord-mcp dashboard to log in. This request came from another origin.");
  const session = await deps.session(request);
  if (session.isErr()) return RequestGuard.errorResponse(session.error.status, session.error.message);
  const body = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return RequestGuard.errorResponse(400, "Expected a login action: start with a light or dark color scheme, poll, or stop.");
  const userId = session.value.userId;
  if (body.data.action === "poll") return noStore(Response.json(await deps.browser.poll(userId)));
  if (body.data.action === "stop") {
    const stopped = await deps.browser.stop(userId);
    return stopped.isErr() ? error(stopped.error) : noStore(new Response(null, { status: 204 }));
  }
  const started = await deps.browser.start(userId, body.data.colorScheme);
  return started.isErr() ? error(started.error) : noStore(Response.json(started.value));
};
const authorize = async (deps: LoginHttpDeps, request: Request): Promise<Response> => {
  const session = await deps.session(request);
  if (session.isErr()) return noStore(new Response(null, { status: session.error.status === 401 ? 401 : 403 }));
  return noStore(new Response(null, { status: deps.browser.canView(session.value.userId) ? 204 : 403 }));
};
const report = async (browser: LoginBrowser, request: Request): Promise<Response> => {
  const secret = request.headers.get("x-login-secret");
  if (!browser.accepts(secret)) return RequestGuard.errorResponse(403, "This login browser report is not authorized or its browser has closed.");
  // Keep the internal credential boundary small. Do not echo bodies or parse errors.
  const text = await request.text();
  if (text.length > 16_384) return RequestGuard.errorResponse(413, "The login browser report is too large.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { return RequestGuard.errorResponse(400, "The login browser report is not valid JSON."); }
  const reported = await browser.report(secret, value);
  return reported.isErr() ? error(reported.error) : noStore(new Response(null, { status: 204 }));
};
export const LoginHttp = { action, authorize, report } as const;
