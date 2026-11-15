import { Result } from "better-result";
import { z } from "zod";
import { DiscordApiSchema } from "./api-schema";
import { DiscordRest } from "./rest";

const list = async (rest: DiscordRest) => {
  const guilds: z.infer<typeof DiscordApiSchema.guild>[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: "200" });
    if (after) query.set("after", after);
    const page = await rest.request("list guilds", "/users/@me/guilds", z.array(DiscordApiSchema.guild), { query });
    if (page.isErr()) return Result.err(page.error);
    if (page.value.some((guild) => seen.has(guild.id)))
      return Result.err(DiscordRest.error("list guilds", null, "Discord repeated a guild page. Try again later."));
    for (const guild of page.value) {
      seen.add(guild.id);
      guilds.push(guild);
    }
    if (page.value.length < 200) return Result.ok(guilds);
    after = page.value.at(-1)?.id;
  }
};
export const DiscordGuilds = { list } as const;
