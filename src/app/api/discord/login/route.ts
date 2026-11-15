import { connection } from "next/server";
import { DiscordLogin } from "@/lib/discord/login-session";
import { LoginEndpoint } from "@/lib/discord/login-endpoint";
import { RequestGuard } from "@/lib/http/request-guard";

async function handle(request: Request): Promise<Response> {
  await connection();
  return LoginEndpoint.handle(
    { origin: RequestGuard.appOrigin(), session: RequestGuard.requireSession, sessions: DiscordLogin.sessions() },
    request,
  );
}
export const GET = handle;
export const POST = handle;
