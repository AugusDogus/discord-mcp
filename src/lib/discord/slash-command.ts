import { Result } from "better-result";
import { z } from "zod";
import { DiscordRest } from "./rest";

export type CommandOption = {
  type: number;
  name: string;
  required?: boolean;
  options?: CommandOption[];
  choices?: { name: string; value: string | number }[];
};
const option: z.ZodType<CommandOption> = z.lazy(() =>
  z.object({
    type: z.number().int(),
    name: z.string(),
    required: z.boolean().optional(),
    options: z.array(option).optional(),
    choices: z.array(z.object({ name: z.string(), value: z.union([z.string(), z.number()]) })).optional(),
  }),
);
const schema = z.object({
  id: z.string(),
  application_id: z.string(),
  version: z.string(),
  name: z.string(),
  type: z.number().default(1),
  options: z.array(option).default([]),
});
export type SlashOption = { type: number; name: string; value?: string | number | boolean; options?: SlashOption[] };

/** Positional string arguments, matching the source tool. Attachments are deliberately unsupported. */
const build = (command: z.infer<typeof schema>, commandName: string, args: string[]) => {
  const [, ...parts] = commandName.trim().split(/\s+/);
  let definitions = command.options;
  const parents: CommandOption[] = [];
  for (const part of parts) {
    const parent = definitions.find((item) => (item.type === 1 || item.type === 2) && item.name === part);
    if (!parent)
      return Result.err(
        DiscordRest.error(
          "invoke slash command",
          null,
          `Subcommand ${part} was not found. Read the application's command names in Discord.`,
        ),
      );
    parents.push(parent);
    definitions = parent.options ?? [];
  }
  if (definitions.some((item) => item.type <= 2) || args.length > definitions.length)
    return Result.err(
      DiscordRest.error(
        "invoke slash command",
        null,
        "Choose a complete subcommand and provide only its positional arguments.",
      ),
    );
  const values: SlashOption[] = [];
  for (const [index, definition] of definitions.entries()) {
    const arg = args[index];
    if (arg === undefined) {
      if (definition.required)
        return Result.err(
          DiscordRest.error(
            "invoke slash command",
            null,
            `Required argument ${definition.name} is missing. Nothing was sent.`,
          ),
        );
      continue;
    }
    const choice = definition.choices?.find((choice) => choice.name === arg || String(choice.value) === arg);
    let value: string | number | boolean = choice?.value ?? arg;
    if (definition.choices?.length && !choice)
      return Result.err(
        DiscordRest.error(
          "invoke slash command",
          null,
          `Argument ${definition.name} must match a command choice. Nothing was sent.`,
        ),
      );
    if (definition.type === 4 || definition.type === 10) {
      value = Number(value);
      if (!arg.trim() || !Number.isFinite(value) || (definition.type === 4 && !Number.isSafeInteger(value)))
        return Result.err(
          DiscordRest.error(
            "invoke slash command",
            null,
            `Argument ${definition.name} must be a valid number. Nothing was sent.`,
          ),
        );
    } else if (definition.type === 5) {
      if (arg !== "true" && arg !== "false")
        return Result.err(
          DiscordRest.error(
            "invoke slash command",
            null,
            `Argument ${definition.name} must be true or false. Nothing was sent.`,
          ),
        );
      value = arg === "true";
    } else if ([6, 7, 8, 9].includes(definition.type)) {
      const id = arg.replace(/^<[@#][!&]?([0-9]+)>$/, "$1");
      if (!/^\d+$/.test(id))
        return Result.err(
          DiscordRest.error(
            "invoke slash command",
            null,
            `Argument ${definition.name} must be a Discord ID. Nothing was sent.`,
          ),
        );
      value = id;
    } else if (definition.type !== 3)
      return Result.err(
        DiscordRest.error(
          "invoke slash command",
          null,
          "This command requires an unsupported argument type, such as an attachment. Use Discord to run it.",
        ),
      );
    values.push({ type: definition.type, name: definition.name, value });
  }
  let options = values;
  for (const parent of parents.toReversed()) options = [{ type: parent.type, name: parent.name, options }];
  return Result.ok({ id: command.id, name: command.name, version: command.version, type: command.type, options });
};
export const DiscordSlashCommand = { schema, build } as const;
