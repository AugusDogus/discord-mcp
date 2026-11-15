import { connection } from "next/server";
import { DiscordRuntime } from "@/lib/discord/runtime";
import { RequestGuard } from "@/lib/http/request-guard";

/** GET ?id=<account id>: one stored account's login state, for the dashboard's refresh. */
export async function GET(request: Request): Promise<Response> {
  await connection();
  const session = await RequestGuard.requireSession(request);
  if (session.isErr()) return RequestGuard.errorResponse(session.error.status, session.error.message);
  const accountId = new URL(request.url).searchParams.get("id");
  if (accountId === null || accountId === "") return RequestGuard.errorResponse(400, "Name the Discord account with ?id=. Nothing was checked.");
  const health = await DiscordRuntime.health({ userId: session.value.userId, accountId });
  return health.isErr()
    ? RequestGuard.errorResponse(503, health.error.message)
    : Response.json(
        { kind: health.value.kind, ...(health.value.kind === "connected" ? { health: health.value.health } : {}) },
        { headers: { "cache-control": "no-store" } },
      );
}
