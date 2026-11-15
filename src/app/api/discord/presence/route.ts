import { connection } from "next/server";
import { DiscordRuntime } from "@/lib/discord/runtime";

export async function POST(request: Request): Promise<Response> {
  await connection();
  return DiscordRuntime.accountAction(request, "presence");
}
