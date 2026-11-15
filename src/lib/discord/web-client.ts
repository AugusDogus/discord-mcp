/**
 * How discord-mcp presents itself to Discord: as the Discord web app in a
 * desktop Chrome. These headers are used only for the existing REST client.
 */

const ORIGIN = "https://discord.com";
const API_BASE = `${ORIGIN}/api/v9`;
const BROWSER_VERSION = "142.0.0.0";
const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION} Safari/537.36`;

/** Base headers for the REST client. The login browser uses its own headers. */
const browserHeaders = (): Record<string, string> => ({
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  origin: ORIGIN,
  referer: `${ORIGIN}/login`,
  "user-agent": USER_AGENT,
});

/** Headers for an authenticated REST call. `token` is never logged. */
const authorizedHeaders = (token: string): Record<string, string> => ({
  ...browserHeaders(),
  referer: `${ORIGIN}/channels/@me`,
  authorization: token,
  "x-discord-locale": "en-US",
});

export const DiscordWebClient = {
  origin: ORIGIN,
  apiBase: API_BASE,
  userAgent: USER_AGENT,
  browserHeaders,
  authorizedHeaders,
} as const;
