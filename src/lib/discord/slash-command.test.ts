import { expect, test } from "bun:test";
import { DiscordSlashCommand } from "./slash-command";

test("slash arguments validate positional types and wrap subcommands", () => {
  const command = DiscordSlashCommand.schema.parse({
    id: "123",
    application_id: "456",
    version: "789",
    name: "test",
    options: [
      {
        type: 1,
        name: "run",
        options: [
          { type: 4, name: "count", required: true },
          { type: 5, name: "enabled" },
          { type: 6, name: "user" },
        ],
      },
    ],
  });
  expect(DiscordSlashCommand.build(command, "test run", ["3", "false", "<@123>"]).unwrap().options).toEqual([
    {
      type: 1,
      name: "run",
      options: [
        { type: 4, name: "count", value: 3 },
        { type: 5, name: "enabled", value: false },
        { type: 6, name: "user", value: "123" },
      ],
    },
  ]);
  for (const args of [[], ["invalid"], ["1", "yes"], ["1", "true", "invalid"], ["1", "true", "123", "extra"]])
    expect(DiscordSlashCommand.build(command, "test run", args).isErr()).toBe(true);
  expect(DiscordSlashCommand.build(command, "test missing", []).isErr()).toBe(true);
});
