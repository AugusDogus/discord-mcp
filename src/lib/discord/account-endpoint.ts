import { Result } from "better-result";
import { z } from "zod";
import type { RequestRejectedError, SignedInRequest } from "@/lib/http/request-guard";
import { RequestGuard } from "@/lib/http/request-guard";
import type { DiscordAccountKey } from "./account-store";

export type AccountEndpointDeps = {
  readonly guard: (request: Request) => Promise<Result<SignedInRequest, RequestRejectedError>>;
  readonly logout: (account: DiscordAccountKey) => Promise<Result<void, { readonly status: number; readonly message: string }>>;
  readonly presence: (account: DiscordAccountKey, enabled: boolean) => Promise<Result<boolean, { readonly message: string }>>;
};
const accountId = z.string().min(1).max(128);
const LogoutSchema = z.object({ accountId }).strict();
const PresenceSchema = z.object({ accountId, enabled: z.boolean() }).strict();

/** Dashboard account actions. Each names one of the signed-in user's stored accounts. */
const handle = async (
  deps: AccountEndpointDeps,
  request: Request,
  action: "logout" | "presence",
): Promise<Response> => {
  const session = await deps.guard(request);
  if (session.isErr()) return RequestGuard.errorResponse(session.error.status, session.error.message);
  const body = await Result.tryPromise({ try: async (): Promise<unknown> => request.json(), catch: () => null });
  const value = body.isOk() ? body.value : null;
  if (action === "logout") {
    const input = LogoutSchema.safeParse(value);
    if (!input.success)
      return RequestGuard.errorResponse(400, "Send the accountId of the Discord account to log out. Nothing was changed.");
    const result = await deps.logout({ userId: session.value.userId, accountId: input.data.accountId });
    return result.isErr()
      ? RequestGuard.errorResponse(result.error.status, result.error.message)
      : Response.json({ loggedOut: true }, { headers: { "cache-control": "no-store" } });
  }
  const input = PresenceSchema.safeParse(value);
  if (!input.success)
    return RequestGuard.errorResponse(
      400,
      "Send an accountId and an enabled boolean to save the presence setting. Nothing was changed.",
    );
  const saved = await deps.presence({ userId: session.value.userId, accountId: input.data.accountId }, input.data.enabled);
  if (saved.isErr()) return RequestGuard.errorResponse(503, saved.error.message);
  if (!saved.value)
    return RequestGuard.errorResponse(404, "That Discord account is not logged in to discord-mcp. Reload the dashboard.");
  return Response.json({ enabled: input.data.enabled }, { headers: { "cache-control": "no-store" } });
};
export const DiscordAccountEndpoint = { handle } as const;
