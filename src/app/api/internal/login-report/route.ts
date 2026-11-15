import { connection } from "next/server";
import { LoginHttp } from "@/lib/login-browser/http";
import { LoginBrowserRuntime } from "@/lib/login-browser/runtime";

export async function POST(request: Request): Promise<Response> {
  await connection();
  return LoginHttp.report(LoginBrowserRuntime.get(), request);
}
