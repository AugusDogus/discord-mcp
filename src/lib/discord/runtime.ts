import { getDb } from "@/lib/db/client";
import { DiscordAccountStore } from "./account-store";
import { DiscordAccountHealth } from "./account-health";
import { DiscordGateway } from "./gateway";
import { DiscordPresence } from "./presence";
import { DiscordRest } from "./rest";

const key = Symbol.for("discord-mcp.presence");
type RuntimeGlobal = typeof globalThis & { [key]?: DiscordPresence };
const sessions = () => {
  const global: RuntimeGlobal = globalThis;
  if (!global[key]) {
    const manager = DiscordPresence.create({ connect: DiscordGateway.connect, now: Date.now, idleMs: 120_000, onlineMs: 180_000 });
    const timer = setInterval(manager.sweep, 1_000);
    timer.unref();
    global[key] = manager;
  }
  return global[key];
};
const rest = (userId: string, token: string) => DiscordRest.create(token, {
  fetch: (url, init) => fetch(url, init),
  rejected: async () => { sessions().stop(userId); return DiscordAccountStore.markRejected(getDb(), userId); },
});
const health = (userId: string) => DiscordAccountHealth.check({
  credentials: (id) => DiscordAccountStore.credentials(getDb(), id), rest,
  verified: (id, user) => DiscordAccountStore.markVerified(getDb(), id, user), now: Date.now,
}, userId);
export const DiscordRuntime = { sessions, rest, health } as const;
