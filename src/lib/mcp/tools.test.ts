import { expect, test } from "bun:test";
import { createMcpHandler, type AuthInfo } from "@modelcontextprotocol/server";
import { Result } from "better-result";
import { z } from "zod";
import { serviceHarness } from "@/lib/discord/testing/fake-service";
import type { McpScope } from "@/lib/oauth/scopes";
import { createDiscordMcpServer } from "./server";
import type { DiscordMcpContext } from "./context";

const requests: Readonly<Record<string, Record<string, unknown>>> = {
  discord_get_account: {},
  discord_list_guilds: {},
  discord_list_guild_channels: { guildId: "123" },
  discord_list_dms: {},
  discord_open_dm: { userId: "123" },
  discord_get_user: { userId: "123" },
  discord_fetch_messages: { channelId: "123" },
  discord_fetch_message: { channelId: "123", messageId: "456" },
  discord_search_messages: { channelId: "123" },
  discord_send_message: { channelId: "123", content: "test" },
  discord_edit_own_message: { channelId: "123", messageId: "456", content: "test" },
  discord_delete_own_message: { channelId: "123", messageId: "456", confirm: false },
  discord_add_reaction: { channelId: "123", messageId: "456", emoji: "👍" },
  discord_remove_own_reaction: { channelId: "123", messageId: "456", emoji: "👍" },
  discord_create_thread: { channelId: "123", messageId: "456", name: "test" },
  discord_update_thread: { threadId: "123", archived: true },
  discord_invoke_slash_command: { channelId: "123", applicationId: "456", commandName: "test" },
  discord_click_button: { channelId: "123", messageId: "456", customId: "test" },
  discord_select_menu: { channelId: "123", messageId: "456", customId: "test", values: ["test"] },
  discord_join_guild: { invite: "test", confirm: false },
  discord_leave_guild: { guildId: "123", confirm: false },
  discord_get_guild_layout: {},
  discord_replace_guild_layout: { folders: [{ guildIds: ["123"] }], confirm: false },
  get_status: {},
};
const reads = new Set([
  "discord_get_account",
  "discord_list_guilds",
  "discord_list_guild_channels",
  "discord_list_dms",
  "discord_get_user",
  "discord_fetch_messages",
  "discord_fetch_message",
  "discord_search_messages",
  "discord_get_guild_layout",
  "get_status",
]);
const rpc = async (
  scopes: readonly McpScope[],
  method: string,
  params: Record<string, unknown> = {},
  extras: Partial<DiscordMcpContext> = {},
  authInfo?: AuthInfo,
) => {
  const handler = createMcpHandler(() =>
    createDiscordMcpServer({
      ...extras,
      auth: { userId: "123", clientId: "test-client", grantId: "test-grant", scopes },
    }),
  );
  return handler.fetch(
    new Request("https://discord-mcp.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    authInfo ? { authInfo } : undefined,
  );
};
const json = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice(6) : text);
};
const result = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string() })),
  }),
});

test("HTTP MCP exposes every source tool and get_status, preserving annotations and dropping attachmentPaths", async () => {
  const response = await json(await rpc(["discord:read", "discord:write"], "tools/list"));
  const tools = z
    .object({
      result: z.object({
        tools: z.array(
          z.object({
            name: z.string(),
            annotations: z.object({ readOnlyHint: z.boolean(), destructiveHint: z.boolean() }),
            inputSchema: z.object({ properties: z.record(z.string(), z.unknown()).optional() }),
          }),
        ),
      }),
    })
    .parse(response).result.tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(requests).sort());
  for (const tool of tools) {
    expect(tool.annotations.readOnlyHint).toBe(reads.has(tool.name));
    expect(tool.annotations.destructiveHint).toBe(
      ["discord_delete_own_message", "discord_leave_guild", "discord_replace_guild_layout"].includes(tool.name),
    );
    expect(tool.inputSchema.properties).not.toHaveProperty("attachmentPaths");
  }
});
test("every tool enforces its read or write scope before loading account credentials", async () => {
  let loaded = 0;
  for (const [name, args] of Object.entries(requests)) {
    const expected = reads.has(name) ? "discord:read" : "discord:write";
    const scopes: McpScope[] = [expected === "discord:read" ? "discord:write" : "discord:read"];
    const response = await rpc(
      scopes,
      "tools/call",
      { name, arguments: args },
      {
        service: async () => {
          loaded++;
          return Result.err({ message: "Should not load." });
        },
        health: async () => {
          loaded++;
          return Result.ok({ kind: "login" });
        },
      },
    );
    const parsed = result.parse(await json(response)).result;
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0]?.text).toContain(expected);
  }
  expect(loaded).toBe(0);
});
test("HTTP scope challenges return 403; destructive calls with confirm false make no Discord requests", async () => {
  const response = await rpc(
    ["discord:read"],
    "tools/call",
    { name: "discord_send_message", arguments: requests.discord_send_message },
    {},
    {
      token: "test-access-token-not-real",
      clientId: "test",
      scopes: ["discord:read"],
      resource: new URL("https://discord-mcp.test/api/mcp"),
    },
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toContain('scope="discord:write"');
  const h = serviceHarness();
  for (const name of [
    "discord_delete_own_message",
    "discord_leave_guild",
    "discord_replace_guild_layout",
    "discord_join_guild",
  ]) {
    const called = result.parse(
      await json(
        await rpc(
          ["discord:write"],
          "tools/call",
          { name, arguments: requests[name] },
          { service: async () => Result.ok(h.service) },
        ),
      ),
    ).result;
    expect(called.isError).toBe(true);
    expect(called.content[0]?.text).toContain("confirm");
  }
  expect(h.calls).toEqual([]);
});
test("get_status reports token health without exposing a token", async () => {
  const response = result.parse(
    await json(
      await rpc(
        ["discord:read"],
        "tools/call",
        { name: "get_status", arguments: {} },
        { health: async () => Result.ok({ kind: "login" }) },
      ),
    ),
  ).result;
  expect(response.isError).toBeUndefined();
  expect(response.content[0]?.text).toContain('"login"');
});
