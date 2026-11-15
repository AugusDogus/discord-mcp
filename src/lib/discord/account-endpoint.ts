import { Result } from "better-result";
import { z } from "zod";
import type { RequestRejectedError, SignedInRequest } from "@/lib/http/request-guard";
import { RequestGuard } from "@/lib/http/request-guard";

export type AccountEndpointDeps = {
  readonly guard: (request: Request) => Promise<Result<SignedInRequest, RequestRejectedError>>;
  readonly logout: (userId: string) => Promise<Result<void, { readonly status: number; readonly message: string }>>;
  readonly presence: (userId: string, enabled: boolean) => Promise<Result<boolean, { readonly message: string }>>;
};
const handle = async (
  deps: AccountEndpointDeps,
  request: Request,
  action: "logout" | "presence",
): Promise<Response> => {
  const session = await deps.guard(request);
  if (session.isErr()) return RequestGuard.errorResponse(session.error.status, session.error.message);
  if (action === "logout") {
    const result = await deps.logout(session.value.userId);
    return result.isErr()
      ? RequestGuard.errorResponse(result.error.status, result.error.message)
      : Response.json({ loggedOut: true }, { headers: { "cache-control": "no-store" } });
  }
  const body = await Result.tryPromise({ try: async (): Promise<unknown> => request.json(), catch: () => null });
  const input = z
    .object({ enabled: z.boolean() })
    .strict()
    .safeParse(body.isOk() ? body.value : null);
  if (!input.success)
    return RequestGuard.errorResponse(
      400,
      "Send an enabled boolean to save the presence setting. Nothing was changed.",
    );
  const saved = await deps.presence(session.value.userId, input.data.enabled);
  if (saved.isErr()) return RequestGuard.errorResponse(503, saved.error.message);
  if (!saved.value) return RequestGuard.errorResponse(409, "Log in to Discord before changing the presence setting.");
  return Response.json({ enabled: input.data.enabled }, { headers: { "cache-control": "no-store" } });
};
export const DiscordAccountEndpoint = { handle } as const;
