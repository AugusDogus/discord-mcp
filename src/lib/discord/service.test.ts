import { expect, test } from "bun:test";
import { message, serviceHarness } from "./testing/fake-service";

test("reading account, guilds, channels, DMs and messages never opens a gateway", async () => {
  const h = serviceHarness(
    [
      [{ id: "123", name: "Test" }],
      [{ id: "789", type: 0 }],
      [{ id: "789", type: 1 }],
      [message],
      message,
      { id: "123", username: "test" },
    ],
    true,
  );
  for (const result of [
    await h.service.getAccount(),
    await h.service.listGuilds(),
    await h.service.listGuildChannels("123"),
    await h.service.listPrivateChannels(),
    await h.service.fetchMessages("789", 25, "456"),
    await h.service.fetchMessage("789", "456"),
    await h.service.getUser("123"),
  ])
    expect(result.isOk()).toBe(true);
  expect(h.statuses).toEqual([]);
  expect(h.calls[3]?.path).toBe("/channels/789/messages?limit=25&before=456");
});
test("sending disables mentions, handles replies and silent flags, and defaults to REST-only", async () => {
  const h = serviceHarness([message]);
  expect((await h.service.sendMessage("789", { content: "test", replyToMessageId: "456", silent: true })).isOk()).toBe(
    true,
  );
  expect(h.calls[0]?.body).toEqual({
    content: "test",
    allowed_mentions: { parse: [], replied_user: false },
    message_reference: { message_id: "456", channel_id: "789", fail_if_not_exists: true },
    flags: 4096,
  });
  expect(h.statuses).toEqual([]);
  expect((await h.service.sendMessage("789", {})).isErr()).toBe(true);
  expect(h.calls).toHaveLength(1);
});
test("only opted-in writes open an online session; reactions encode emoji", async () => {
  const h = serviceHarness([null, null], true);
  expect((await h.service.addReaction("789", "456", "hello:123")).isOk()).toBe(true);
  expect(h.statuses).toEqual(["online"]);
  expect(h.calls[0]?.path).toBe("/channels/789/messages/456/reactions/hello%3A123/@me");
  await h.service.removeOwnReaction("789", "456", "👍");
  expect(h.calls[1]?.method).toBe("DELETE");
});
test("destructive tools require confirmation before even reading a target", async () => {
  const h = serviceHarness();
  for (const result of [
    await h.service.deleteOwnMessage("789", "456", false),
    await h.service.leaveGuild("123", false),
    await h.service.joinGuild("test", false),
    await h.service.replaceGuildLayout([{ guildIds: ["123"] }], false),
  ])
    expect(result.isErr()).toBe(true);
  expect(h.calls).toEqual([]);
  expect(h.statuses).toEqual([]);
});
test("edit and delete refuse another author's message; own delete performs REST DELETE", async () => {
  const other = { ...message, author: { id: "999", username: "other" } };
  const h = serviceHarness([other, other, message, null]);
  expect((await h.service.editOwnMessage("789", "456", "test")).isErr()).toBe(true);
  expect((await h.service.deleteOwnMessage("789", "456", true)).isErr()).toBe(true);
  expect((await h.service.deleteOwnMessage("789", "456", true)).unwrap()).toEqual({
    deleted: true,
    channelId: "789",
    messageId: "456",
  });
  expect(h.calls.map((call) => call.method)).toEqual(["GET", "GET", "GET", "DELETE"]);
});
test("guild owners cannot leave, invalid invites never reach Discord", async () => {
  const h = serviceHarness([{ id: "456", name: "Test", owner_id: "123" }]);
  expect((await h.service.leaveGuild("456", true)).isErr()).toBe(true);
  expect((await h.service.joinGuild("https://other.test/test", true)).isErr()).toBe(true);
  expect(h.calls).toHaveLength(1);
});
test("search uses guild REST search and repeated filter keys", async () => {
  const h = serviceHarness([
    { id: "789", guild_id: "123", type: 0 },
    { total_results: 1, messages: [[message]] },
  ]);
  const result = await h.service.searchMessages("789", { authorIds: ["123", "456"], content: "test", pinned: true });
  expect(result.unwrap()).toMatchObject({ total: 1, messages: [{ id: "456", channelId: "789" }] });
  const url = new URL(`https://test.invalid${h.calls[1]?.path}`);
  expect(url.pathname).toBe("/guilds/123/messages/search");
  expect(url.searchParams.getAll("author_id")).toEqual(["123", "456"]);
});
test("interactions open invisible sessions on demand and post session IDs through REST", async () => {
  const h = serviceHarness([
    { ...message, components: [{ type: 1, components: [{ type: 2, custom_id: "test-button" }] }] },
    { id: "789", type: 1 },
    null,
  ]);
  expect((await h.service.clickButton("789", "456", "test-button")).isOk()).toBe(true);
  expect(h.statuses).toEqual(["invisible"]);
  expect(h.calls[2]).toMatchObject({
    path: "/interactions",
    method: "POST",
    body: { type: 3, session_id: "test-session", data: { component_type: 2, custom_id: "test-button" } },
  });
  h.sessions.stop("123");
});
test("disabled or invalid menu components never open a gateway", async () => {
  const h = serviceHarness([
    { ...message, components: [{ type: 3, custom_id: "test-menu", options: [{ value: "one" }], max_values: 1 }] },
  ]);
  expect((await h.service.selectMenu("789", "456", "test-menu", ["two"])).isErr()).toBe(true);
  expect(h.statuses).toEqual([]);
  expect(h.calls).toHaveLength(1);
});

test("guild components use the channel's guild ID when the REST message omits it", async () => {
  const h = serviceHarness([
    { ...message, components: [{ type: 1, components: [{ type: 2, custom_id: "test-button" }] }] },
    { id: "789", type: 0, guild_id: "999" },
    null,
  ]);
  const result = await h.service.clickButton("789", "456", "test-button");
  expect(result.isOk()).toBe(true);
  expect(h.calls.at(-1)?.body).toMatchObject({ guild_id: "999", channel_id: "789" });
  h.sessions.stop("123");
});
