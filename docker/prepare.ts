import { SelfHosting } from "../src/lib/self-hosting";

const prepared = await SelfHosting.prepare("/data", process.env);
if (prepared.isErr()) {
  console.error(`[discord-mcp] ${prepared.error.message}`);
  process.exit(1);
}
