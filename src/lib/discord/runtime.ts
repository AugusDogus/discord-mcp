import { getDb } from "@/lib/db/client";
import { DiscordAccountLease } from "./account-lease";
import { DiscordAccountEndpoint } from "./account-endpoint";
import { DiscordLogout } from "./logout";
import { LoginBrowserRuntime } from "@/lib/login-browser/runtime";
import { RequestGuard } from "@/lib/http/request-guard";
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
    const manager = DiscordPresence.create({
      connect: DiscordGateway.connect,
      now: Date.now,
      idleMs: 120_000,
      onlineMs: 180_000,
    });
    const timer = setInterval(manager.sweep, 1_000);
    timer.unref();
    global[key] = manager;
  }
  return global[key];
};
const rest = (userId: string, token: string) =>
  DiscordRest.create(token, {
    fetch: (url, init) => fetch(url, init),
    rejected: async () => {
      sessions().stop(userId);
      return DiscordAccountStore.markRejected(getDb(), userId);
    },
  });
const health = (userId: string) =>
  DiscordAccountLease.run(userId, () =>
    DiscordAccountHealth.check(
      {
        credentials: (id) => DiscordAccountStore.credentials(getDb(), id),
        rest,
        verified: (id, user) => DiscordAccountStore.markVerified(getDb(), id, user),
        now: Date.now,
      },
      userId,
    ),
  );
const accountAction = (request: Request, action: "logout" | "presence") =>
  DiscordAccountEndpoint.handle(
    {
      guard: RequestGuard.requireSignedIn,
      logout: (userId) =>
        DiscordAccountLease.run(userId, () =>
          DiscordLogout.run(
            {
              db: getDb(),
              credentials: (id) => DiscordAccountStore.credentials(getDb(), id),
              rest,
              stop: (id) => {
                void LoginBrowserRuntime.get().stop(id);
                sessions().stop(id);
              },
            },
            userId,
          ),
        ),
      presence: (userId, enabled) =>
        DiscordAccountLease.run(userId, async () => {
          const saved = await DiscordAccountStore.setPresenceOnWrite(getDb(), userId, enabled);
          if (saved.isOk()) sessions().stop(userId);
          return saved;
        }),
    },
    request,
    action,
  );
export const DiscordRuntime = { sessions, rest, health, accountAction } as const;
