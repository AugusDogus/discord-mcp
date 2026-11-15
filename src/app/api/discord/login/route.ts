import { connection } from "next/server";
import { LoginHttp } from "@/lib/login-browser/http";
import { LoginBrowserRuntime } from "@/lib/login-browser/runtime";
import { RequestGuard } from "@/lib/http/request-guard";

export async function POST(request: Request): Promise<Response> {
  await connection();
  return LoginHttp.action({ origin: RequestGuard.appOrigin(), session: RequestGuard.requireSession, browser: LoginBrowserRuntime.get() }, request);
}
