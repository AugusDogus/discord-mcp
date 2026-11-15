import { expect, test } from "bun:test";
import { z } from "zod";
import { PreloadedUserSettings } from "discord-protos";
import { DiscordGuildLayout } from "./guild-layout";
import { serviceHarness } from "./testing/fake-service";

test("guild layout requires a complete unique inventory", () => {
  const known = new Set(["123", "456"]);
  expect(DiscordGuildLayout.validate([{ guildIds: ["123", "456"] }], known)).toBeNull();
  for (const folders of [
    [{ guildIds: ["123"] }],
    [{ guildIds: ["123", "123"] }],
    [{ guildIds: ["999"] }],
    [{ guildIds: [] }],
  ])
    expect(DiscordGuildLayout.validate(folders, known)).not.toBeNull();
});
test("layout patches only guild folders with version protection, preserving saved status", async () => {
  const settings = PreloadedUserSettings.toBase64(PreloadedUserSettings.create({ versions: { dataVersion: 3 } }));
  const h = serviceHarness([[{ id: "123", name: "test" }], { settings }, { settings }, { settings }]);
  expect((await h.service.replaceGuildLayout([{ guildIds: ["123"] }], true)).isOk()).toBe(true);
  const body = h.calls[2]?.body;
  const parsed = z.object({ settings: z.string(), required_data_version: z.number() }).parse(body);
  expect(parsed.required_data_version).toBe(3);
  const patch = PreloadedUserSettings.fromBase64(parsed.settings);
  expect(patch.status).toBeUndefined();
  expect(patch.guildFolders?.folders[0]?.guildIds).toEqual([123n]);
  expect(h.statuses).toEqual([]);
});
