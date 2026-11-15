import type { Result } from "better-result";
import type { RequestRejectedError, SignedInRequest } from "@/lib/http/request-guard";
import { RequestGuard } from "@/lib/http/request-guard";
import type { LoginSessions } from "./login-session";

export type LoginEndpointDeps = {
  readonly origin: string;
  readonly session: (request: Request) => Promise<Result<SignedInRequest, RequestRejectedError>>;
  readonly sessions: Pick<LoginSessions, "poll" | "restart">;
};

const handle = async (deps: LoginEndpointDeps, request: Request): Promise<Response> => {
  // GET starts a QR session too. Validate browser headers, not the internal
  // HTTP origin Next may receive behind Tailscale Serve.
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  const foreignSite = site !== null && site !== "same-origin" && site !== "none";
  if (foreignSite || (origin !== null ? origin !== deps.origin : request.method !== "GET")) {
    return RequestGuard.errorResponse(
      403,
      "Open the discord-mcp dashboard to log in. This request came from another origin.",
    );
  }
  const session = await deps.session(request);
  if (session.isErr()) return RequestGuard.errorResponse(session.error.status, session.error.message);
  const view =
    request.method === "POST"
      ? deps.sessions.restart(session.value.userId)
      : await deps.sessions.poll(session.value.userId);
  return Response.json(view, { headers: { "cache-control": "no-store" } });
};

export const LoginEndpoint = { handle } as const;
