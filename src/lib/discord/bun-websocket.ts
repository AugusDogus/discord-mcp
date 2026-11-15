import { Result, TaggedError } from "better-result";

/**
 * Discord's WebSocket gateways through Bun's built-in client. Discord's
 * Cloudflare edge answers the TLS handshake of Node and of the `ws` package
 * (even on Bun) with HTTP 403, but accepts Bun's own client, which can also
 * send the Origin and User-Agent Discord expects. So discord-mcp runs on Bun.
 */

/** Bun's constructor, which takes headers (the DOM typing in this project does not). */
type BunWebSocketConstructor = new (url: string, options: Bun.WebSocketOptions) => WebSocket;

export class BunWebSocketUnavailableError extends TaggedError("BunWebSocketUnavailableError")<{ message: string }> {}

const isBunConstructor = (value: unknown): value is BunWebSocketConstructor =>
  typeof Bun !== "undefined" && typeof value === "function";

/** Opens a socket with these headers, or explains that the server is not running on Bun. */
const open = (
  url: string,
  headers: Readonly<Record<string, string>>,
): Result<WebSocket, BunWebSocketUnavailableError> => {
  const constructor: unknown = globalThis.WebSocket;
  if (!isBunConstructor(constructor)) {
    return Result.err(
      new BunWebSocketUnavailableError({
        message:
          "discord-mcp must run on Bun: Discord refuses WebSocket connections from Node. Nothing was sent to Discord. Start the server with `bun server.js` (the Docker image does).",
      }),
    );
  }
  return Result.ok(new constructor(url, { headers: { ...headers } }));
};

/** A message's text; Discord's gateways send JSON text frames. */
const text = (data: unknown): string =>
  typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data);

export const BunWebSocket = { open, text } as const;
