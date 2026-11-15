import { Result } from "better-result";
import { DiscordService } from "../service";
import { DiscordRest } from "../rest";
import { DiscordPresence } from "../presence";
import type { GatewayStatus } from "../gateway";

const user = { id: "123", username: "test", globalName: null, discriminator: "0", avatar: null };
export const message = {
  id: "456",
  channel_id: "789",
  content: "test",
  author: { id: "123", username: "test" },
  timestamp: "2026-11-14T12:00:00.000Z",
};
export const serviceHarness = (responses: unknown[] = [], online = false) => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const statuses: GatewayStatus[] = [];
  const sessions = DiscordPresence.create({
    now: () => 0,
    idleMs: 120_000,
    onlineMs: 180_000,
    connect: async (_, status) => {
      statuses.push(status);
      return Result.ok({ sessionId: "test-session", alive: () => true, setStatus: () => {}, close: () => {} });
    },
  });
  const rest = DiscordRest.create("test-token-not-real", {
    rejected: async () => Result.ok(null),
    fetch: async (url, init) => {
      calls.push({
        path: url.replace("https://discord.com/api/v9", ""),
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      });
      const response = responses.shift();
      return response instanceof Response
        ? response
        : response === null
          ? new Response(null, { status: 204 })
          : Response.json(response ?? {});
    },
  });
  const service = DiscordService.create({
    rest,
    sessions,
    credentials: {
      token: "test-token-not-real",
      record: { userId: "123", user, status: "active", presenceOnWrite: online, lastVerifiedAt: null },
    },
    rejected: async () => Result.ok(null),
  });
  return { service, rest, sessions, calls, statuses };
};
