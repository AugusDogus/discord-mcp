import { Result } from "better-result";
import type { GatewayConnect, GatewaySession, GatewayStatus } from "./gateway";
import { DiscordRest, type DiscordApiError } from "./rest";

export type PresenceDeps = {
  readonly connect: GatewayConnect;
  readonly now: () => number;
  readonly idleMs: number;
  readonly onlineMs: number;
};
type Entry = {
  readonly token: string;
  readonly controller: AbortController;
  readonly connecting: Promise<Result<GatewaySession, DiscordApiError>>;
  busy: number;
  expiresAt: number;
  status: GatewayStatus;
};

/**
 * Sessions exist only for interactions or an explicitly enabled write. Reads
 * never call this module. Sessions are keyed by stored Discord account id.
 */
const create = (deps: PresenceDeps) => {
  const entries = new Map<string, Entry>();
  const stop = (accountId: string) => {
    const entry = entries.get(accountId);
    entries.delete(accountId);
    entry?.controller.abort();
  };
  const sweep = () => {
    for (const [id, entry] of entries) if (entry.busy === 0 && deps.now() >= entry.expiresAt) stop(id);
  };
  const withSession = async <T>(
    accountId: string,
    token: string,
    online: boolean,
    action: (session: GatewaySession) => Promise<Result<T, DiscordApiError>>,
  ): Promise<Result<T, DiscordApiError>> => {
    sweep();
    let entry = entries.get(accountId);
    if (entry && entry.token !== token) {
      stop(accountId);
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      const status = online ? "online" : "invisible";
      entry = {
        token,
        controller,
        status,
        connecting: deps.connect(token, status, controller.signal),
        busy: 0,
        expiresAt: deps.now() + deps.idleMs,
      };
      entries.set(accountId, entry);
    }
    const current = entry;
    current.busy += 1;
    try {
      const connected = await current.connecting;
      if (connected.isErr()) {
        if (entries.get(accountId) === current) stop(accountId);
        return connected;
      }
      if (current.controller.signal.aborted || !connected.value.alive()) {
        if (entries.get(accountId) === current) stop(accountId);
        return Result.err(
          DiscordRest.error(
            "use an interaction session",
            null,
            "The Discord session closed. No action was sent; try again.",
          ),
        );
      }
      const status = online ? "online" : "invisible";
      if (current.status !== status) {
        connected.value.setStatus(status);
        current.status = status;
      }
      return await action(connected.value);
    } finally {
      current.busy -= 1;
      current.expiresAt = deps.now() + (online ? deps.onlineMs : deps.idleMs);
    }
  };
  return { withSession, stop, sweep, activeCount: () => entries.size } as const;
};
export type DiscordPresence = ReturnType<typeof create>;
export const DiscordPresence = { create } as const;
