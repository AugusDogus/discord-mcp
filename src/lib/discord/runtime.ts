import { Result } from "better-result";
import { getDb } from "@/lib/db/client";
import { DiscordAccountLease } from "./account-lease";
import { DiscordAccountEndpoint } from "./account-endpoint";
import { DiscordLogout } from "./logout";
import { RequestGuard } from "@/lib/http/request-guard";
import { DiscordAccountStore, type DiscordAccountKey } from "./account-store";
import { DiscordAccountHealth, type AccountHealth } from "./account-health";
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
const rest = (account: DiscordAccountKey, token: string) =>
  DiscordRest.create(token, {
    fetch: (url, init) => fetch(url, init),
    rejected: async () => {
      sessions().stop(account.accountId);
      return DiscordAccountStore.markRejected(getDb(), account);
    },
  });
const checkHealth = (account: DiscordAccountKey) =>
  DiscordAccountHealth.check(
    {
      credentials: (id) => DiscordAccountStore.credentials(getDb(), id),
      rest,
      verified: (id, user) => DiscordAccountStore.markVerified(getDb(), id, user),
      now: Date.now,
    },
    account,
  );
const health = (account: DiscordAccountKey) => DiscordAccountLease.run(account.userId, () => checkHealth(account));

/** A stored account as the dashboard lists it. */
export type DashboardAccount =
  | { readonly kind: "health"; readonly id: string; readonly health: AccountHealth }
  | { readonly kind: "unreadable"; readonly id: string; readonly message: string };

/** Every stored account of the user with its current health, oldest first. */
const accounts = (userId: string): Promise<Result<DashboardAccount[], { readonly message: string }>> =>
  DiscordAccountLease.run(userId, async () => {
    const listed = await DiscordAccountStore.list(getDb(), userId);
    if (listed.isErr()) return listed;
    const result: DashboardAccount[] = [];
    for (const entry of listed.value) {
      if (entry.kind === "unreadable") {
        result.push({ kind: "unreadable", id: entry.id, message: entry.error.message });
        continue;
      }
      const checked = await checkHealth({ userId, accountId: entry.record.id });
      if (checked.isErr()) return checked;
      result.push({ kind: "health", id: entry.record.id, health: checked.value });
    }
    return Result.ok(result);
  });

const accountAction = (request: Request, action: "logout" | "presence") =>
  DiscordAccountEndpoint.handle(
    {
      guard: RequestGuard.requireSignedIn,
      logout: (account) =>
        DiscordAccountLease.run(account.userId, () =>
          DiscordLogout.run(
            {
              db: getDb(),
              credentials: (id) => DiscordAccountStore.credentials(getDb(), id),
              rest,
              stop: (id) => sessions().stop(id.accountId),
              now: Date.now,
            },
            account,
          ),
        ),
      presence: (account, enabled) =>
        DiscordAccountLease.run(account.userId, async () => {
          const saved = await DiscordAccountStore.setPresenceOnWrite(getDb(), account, enabled);
          if (saved.isOk()) sessions().stop(account.accountId);
          return saved;
        }),
    },
    request,
    action,
  );
export const DiscordRuntime = { sessions, rest, health, accounts, accountAction } as const;
