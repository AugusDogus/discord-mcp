import type { CallToolResult } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { DiscordAccountLease } from "@/lib/discord/account-lease";
import { DiscordAccountStore } from "@/lib/discord/account-store";
import { DiscordRuntime } from "@/lib/discord/runtime";
import { DiscordService } from "@/lib/discord/service";
import { getDb } from "@/lib/db/client";
import { OAuthGrants } from "@/lib/oauth/grants";
import type { McpScope } from "@/lib/oauth/scopes";
import type { DiscordMcpContext } from "./context";
import { ToolScope } from "./scopes";

const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });
const toToolResult = <T>(result: Result<T, { readonly message: string }>): CallToolResult =>
  result.isErr()
    ? failure(result.error.message)
    : { content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }] };

const load = async (userId: string) => {
  const credentials = await DiscordAccountStore.credentials(getDb(), userId);
  if (credentials.isErr()) return credentials;
  if (credentials.value === null || credentials.value.record.status !== "active")
    return Result.err({ message: "Log in to Discord from the discord-mcp dashboard, then retry. Nothing was sent." });
  return Result.ok(
    DiscordService.create({
      credentials: credentials.value,
      rest: DiscordRuntime.rest(userId, credentials.value.token),
      sessions: DiscordRuntime.sessions(),
      rejected: () => DiscordAccountStore.markRejected(getDb(), userId),
    }),
  );
};
const run = async (
  ctx: DiscordMcpContext,
  scope: McpScope,
  action: (service: DiscordService) => Promise<Result<unknown, { readonly message: string }>>,
): Promise<CallToolResult> => {
  const denied = ToolScope.check(ctx, scope);
  if (denied) return denied;
  return DiscordAccountLease.run(ctx.auth.userId, async () => {
    // A request can have waited behind logout after its HTTP authentication.
    if (ctx.service === undefined) {
      const grant = await OAuthGrants.load(getDb(), ctx.auth.grantId);
      if (grant.isErr()) return failure(grant.error.message);
      if (grant.value === null || grant.value.revokedAt !== null || grant.value.userId !== ctx.auth.userId)
        return failure("This agent was disconnected. Re-authorize it from the dashboard before retrying.");
    }
    const service = await (ctx.service ?? load)(ctx.auth.userId);
    if (service.isErr()) return failure(service.error.message);
    return toToolResult(await action(service.value));
  });
};
export const ToolRunner = { run, toToolResult } as const;
