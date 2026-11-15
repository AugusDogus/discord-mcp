import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { DiscordAccountStore } from "@/lib/discord/account-store";
import { DiscordRuntime } from "@/lib/discord/runtime";
import { DiscordService } from "@/lib/discord/service";
import { getDb } from "@/lib/db/client";
import type { McpScope } from "@/lib/oauth/scopes";
import type { DiscordMcpContext } from "./context";
import { ToolScope } from "./scopes";

const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
const toToolResult = <T>(result: Result<T, { readonly message: string }>): CallToolResult => result.isErr()
  ? failure(result.error.message)
  : { content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }] };

const load = async (userId: string) => {
  const credentials = await DiscordAccountStore.credentials(getDb(), userId);
  if (credentials.isErr()) return credentials;
  if (credentials.value === null || credentials.value.record.status !== "active") return Result.err({ message: "Log in to Discord from the discord-mcp dashboard, then retry. Nothing was sent." });
  return Result.ok(DiscordService.create({ credentials: credentials.value, rest: DiscordRuntime.rest(userId, credentials.value.token), sessions: DiscordRuntime.sessions(), rejected: () => DiscordAccountStore.markRejected(getDb(), userId) }));
};
const run = async (ctx: DiscordMcpContext, scope: McpScope, action: (service: DiscordService) => Promise<Result<unknown, { readonly message: string }>>): Promise<CallToolResult> => {
  const denied = ToolScope.check(ctx, scope);
  if (denied) return denied;
  const service = await (ctx.service ?? load)(ctx.auth.userId);
  if (service.isErr()) return failure(service.error.message);
  return toToolResult(await action(service.value));
};
export const ToolRunner = { run, toToolResult } as const;
