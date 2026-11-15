import { connection } from "next/server";
import { DiscordRuntime } from "@/lib/discord/runtime";
import { RequestGuard } from "@/lib/http/request-guard";

export async function GET(request: Request): Promise<Response> {
  await connection();
  const session = await RequestGuard.requireSession(request);
  if (session.isErr()) return RequestGuard.errorResponse(session.error.status, session.error.message);
  const health = await DiscordRuntime.health(session.value.userId);
  return health.isErr()
    ? RequestGuard.errorResponse(503, health.error.message)
    : Response.json(
        { kind: health.value.kind, ...(health.value.kind === "connected" ? { health: health.value.health } : {}) },
        { headers: { "cache-control": "no-store" } },
      );
}
