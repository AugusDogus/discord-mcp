import { Result } from "better-result";
import { z } from "zod";
import { BunWebSocket, type BunWebSocketUnavailableError } from "./bun-websocket";
import { DiscordRest, type DiscordApiError } from "./rest";
import { DiscordWebClient } from "./web-client";

export type GatewayStatus = "invisible" | "online";
export type GatewaySession = {
  readonly sessionId: string;
  readonly alive: () => boolean;
  readonly setStatus: (status: GatewayStatus) => void;
  readonly close: () => void;
};
export type GatewaySocket = { readonly send: (data: string) => void; readonly close: () => void };
export type GatewaySocketEvents = {
  readonly message: (text: string) => void;
  readonly closed: (code: number) => void;
};
export type GatewayOpenSocket = (events: GatewaySocketEvents) => Result<GatewaySocket, BunWebSocketUnavailableError>;
export type GatewayConnect = (
  token: string,
  status: GatewayStatus,
  signal: AbortSignal,
) => Promise<Result<GatewaySession, DiscordApiError>>;

const Packet = z.object({
  op: z.number().int(),
  s: z.number().int().nullable().optional(),
  t: z.string().nullable().optional(),
  d: z.unknown(),
});
const presence = (status: GatewayStatus) => ({ status, since: 0, activities: [], afk: false });

/** A minimal non-resuming session. It never reads or writes saved account settings. */
const connectWith =
  (open: GatewayOpenSocket, timeoutMs = 15_000): GatewayConnect =>
  (token, status, signal) =>
    new Promise((resolve) => {
      let socket: GatewaySocket | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let sequence: number | null = null;
      let acknowledged = true;
      let stage: "opening" | "identifying" | "ready" | "closed" = "opening";
      const fail = (message: string, httpStatus: number | null = null) => {
        if (stage === "closed") return;
        const wasReady = stage === "ready";
        stage = "closed";
        clearTimeout(timeout);
        clearInterval(heartbeat);
        signal.removeEventListener("abort", abort);
        socket?.close();
        if (!wasReady) resolve(Result.err(DiscordRest.error("open an interaction session", httpStatus, message)));
      };
      const abort = () => fail("The interaction session was stopped. No saved Discord status was changed.");
      const timeout = setTimeout(
        () => fail("Discord did not open an interaction session in time. Try again later."),
        timeoutMs,
      );
      const send = (value: unknown) => {
        if (stage === "closed") return;
        try {
          socket?.send(JSON.stringify(value));
        } catch {
          fail("The Discord interaction connection failed. Check Discord before retrying the action.");
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        const opened = open({
          closed: (code) =>
            fail(
              code === 4004
                ? "Discord rejected the login. Log in again from the dashboard."
                : "Discord closed the interaction session. Try again later.",
              code === 4004 ? 401 : null,
            ),
          message: (text) => {
            if (stage === "closed") return;
            const decoded = Result.try({ try: (): unknown => JSON.parse(text), catch: () => null });
            const packet = Packet.safeParse(decoded.isOk() ? decoded.value : null);
            if (!packet.success) {
              fail("Discord sent an unreadable gateway message. Try again later.");
              return;
            }
            const { op, d, s, t } = packet.data;
            if (s !== undefined && s !== null) sequence = s;
            if (op === 10) {
              const hello = z.object({ heartbeat_interval: z.number().int().min(100).max(120_000) }).safeParse(d);
              if (!hello.success || stage !== "opening") {
                fail("Discord sent an unexpected session handshake.");
                return;
              }
              stage = "identifying";
              heartbeat = setInterval(() => {
                if (!acknowledged) {
                  fail("Discord stopped acknowledging the interaction session. Try again later.");
                  return;
                }
                acknowledged = false;
                send({ op: 1, d: sequence });
              }, hello.data.heartbeat_interval);
              heartbeat.unref?.();
              send({
                op: 2,
                d: {
                  token,
                  capabilities: 0,
                  compress: false,
                  properties: { os: "Windows", browser: "Chrome", device: "" },
                  presence: presence(status),
                },
              });
            } else if (op === 11) acknowledged = true;
            else if (op === 1) send({ op: 1, d: sequence });
            else if (op === 7 || op === 9) fail("Discord ended the interaction session. Try again later.");
            else if (op === 0 && t === "READY") {
              if (stage !== "identifying") {
                fail("Discord opened a session before the identify handshake. Try again later.");
                return;
              }
              const data = z.object({ session_id: z.string().min(1) }).safeParse(d);
              if (!data.success) {
                fail("Discord opened a session without a session ID. Try again later.");
                return;
              }
              stage = "ready";
              clearTimeout(timeout);
              resolve(
                Result.ok({
                  sessionId: data.data.session_id,
                  alive: () => stage === "ready",
                  setStatus: (next) => send({ op: 3, d: presence(next) }),
                  close: abort,
                }),
              );
            }
          },
        });
        if (opened.isErr()) return fail(opened.error.message);
        socket = opened.value;
      } catch {
        fail("Could not connect to Discord's interaction gateway. Try again later.");
      }
    });

/** The production transport: Bun's WebSocket (./bun-websocket.ts explains why). */
const liveSocket: GatewayOpenSocket = (events) => {
  const opened = BunWebSocket.open("wss://gateway.discord.gg/?v=9&encoding=json", DiscordWebClient.browserHeaders());
  if (opened.isErr()) return opened;
  const socket = opened.value;
  socket.addEventListener("message", (event) => events.message(BunWebSocket.text(event.data)));
  // A failed connection fires `error`, then `close` with its code.
  socket.addEventListener("close", (event) => events.closed(event.code));
  return Result.ok({
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: () => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000);
    },
  });
};
export const DiscordGateway = { connectWith, connect: connectWith(liveSocket) } as const;
