/**
 * Loaded into the Next.js server process of the demo recording only
 * (`NODE_OPTIONS=--import`, see ./record.ts). It never runs in the app.
 *
 * The demo's Discord account has a made-up token, so the server must never
 * reach Discord with it. Every path that would goes through `fetch` (REST:
 * the dashboard's and `/api/discord/account`'s login check, logout, tools)
 * or a WebSocket (the presence and interaction gateways; on Node, which the
 * recording uses, src/lib/discord/bun-websocket.ts already refuses to open
 * one). Here:
 *
 * - `GET https://discord.com/api/v9/users/@me` answers with the demo profile
 *   (`DEMO_DISCORD_USER`, the API's JSON shape), so the login check marks
 *   the account verified without a network call.
 * - Any other request to a Discord host, and any WebSocket to one, fails
 *   and prints `[demo] blocked`, which makes ./record.ts fail.
 */
const DISCORD_HOST = /(^|\.)(discord\.com|discord\.gg|discordapp\.com|discordapp\.net|discord\.media)$/i;
const profile = process.env.DEMO_DISCORD_USER ?? "";

const hostOf = (input) => {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
};

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = hostOf(input);
  if (url === null || !DISCORD_HOST.test(url.hostname)) return realFetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "GET" && url.origin === "https://discord.com" && url.pathname === "/api/v9/users/@me" && profile !== "") {
    return Promise.resolve(new Response(profile, { status: 200, headers: { "content-type": "application/json" } }));
  }
  // Path only: never print headers or bodies (they carry the token).
  console.error(`[demo] blocked ${method} ${url.origin}${url.pathname}`);
  return Promise.reject(new TypeError("demo: requests to Discord are blocked"));
};

const RealWebSocket = globalThis.WebSocket;
if (typeof RealWebSocket === "function") {
  globalThis.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args) {
      const url = hostOf(args[0]);
      if (url !== null && DISCORD_HOST.test(url.hostname)) {
        console.error(`[demo] blocked WebSocket ${url.origin}${url.pathname}`);
        throw new TypeError("demo: WebSockets to Discord are blocked");
      }
      return Reflect.construct(target, args);
    },
  });
}
