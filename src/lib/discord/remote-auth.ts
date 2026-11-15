import { constants, createHash, generateKeyPair, privateDecrypt, type KeyObject } from "node:crypto";
import { Result, TaggedError } from "better-result";
import WebSocket from "ws";
import { z } from "zod";
import { DiscordUser } from "./user";
import { DiscordWebClient } from "./web-client";

/**
 * Discord's remote-auth v2 ("Log in with QR code"), client side:
 *
 *   gateway -> hello {heartbeat_interval, timeout_ms}
 *   client  -> init {encoded_public_key: base64(SPKI DER of an RSA-2048 key)}
 *   gateway -> nonce_proof {encrypted_nonce}
 *   client  -> nonce_proof {proof: base64url(sha256(nonce)), unpadded}
 *   gateway -> pending_remote_init {fingerprint}   QR = https://discord.com/ra/<fingerprint>
 *   gateway -> pending_ticket {encrypted_user_payload}   scanned: "id:discriminator:avatar:username"
 *   gateway -> pending_login {ticket}   approved on the phone
 *   client  -> POST /users/@me/remote-auth/login {ticket} -> {encrypted_token}
 *   gateway -> cancel   cancelled on the phone
 *
 * Every payload the gateway encrypts uses RSA-OAEP with SHA-256 under our
 * key. One `run` is one QR code: it ends logged in, cancelled, expired,
 * aborted by the caller, or with a typed error. The token is returned, never
 * logged.
 */

export type RemoteAuthProgress =
  | { readonly kind: "qr"; readonly url: string; readonly expiresAt: number }
  | { readonly kind: "scanned"; readonly user: DiscordUser };

export type RemoteAuthOutcome =
  | { readonly kind: "loggedIn"; readonly token: string; readonly user: DiscordUser }
  /** The person tapped Cancel on the phone. */
  | { readonly kind: "cancelled" }
  /** The QR code timed out (or the gateway closed after showing it). */
  | { readonly kind: "expired" }
  /** The caller's signal stopped it. */
  | { readonly kind: "aborted" };

/** The gateway closed or failed before it handed out a QR code. */
export class RemoteAuthConnectionError extends TaggedError("RemoteAuthConnectionError")<{
  closeCode: number | null;
  message: string;
}> {}

/** The gateway sent something this client does not understand, or that does not decrypt. */
export class RemoteAuthProtocolError extends TaggedError("RemoteAuthProtocolError")<{
  stage: string;
  reason: string;
  message: string;
}> {}

/** Discord asked for a captcha to finish the login. */
export class RemoteAuthCaptchaError extends TaggedError("RemoteAuthCaptchaError")<{
  service: string | null;
  message: string;
}> {}

/** Discord answered an HTTP request with an error status. */
export class RemoteAuthHttpError extends TaggedError("RemoteAuthHttpError")<{
  operation: string;
  status: number;
  message: string;
}> {}

/** An HTTP request to Discord did not complete. */
export class RemoteAuthNetworkError extends TaggedError("RemoteAuthNetworkError")<{
  operation: string;
  message: string;
}> {}

export type RemoteAuthError =
  | RemoteAuthConnectionError
  | RemoteAuthProtocolError
  | RemoteAuthCaptchaError
  | RemoteAuthHttpError
  | RemoteAuthNetworkError;

/** The transport: a WebSocket in production, a fake gateway in tests. */
export type RemoteAuthSocket = { readonly send: (text: string) => void; readonly close: () => void };
export type RemoteAuthSocketEvents = {
  readonly onMessage: (text: string) => void;
  readonly onClose: (code: number | null) => void;
};
export type OpenRemoteAuthSocket = (
  url: string,
  headers: Readonly<Record<string, string>>,
  events: RemoteAuthSocketEvents,
) => RemoteAuthSocket;

export type RemoteAuthDeps = {
  readonly openSocket: OpenRemoteAuthSocket;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
};

export type RemoteAuthRunOptions = {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: RemoteAuthProgress) => void;
};

const QR_URL_BASE = `${DiscordWebClient.origin}/ra/`;

const GatewayMessageSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("hello"),
    heartbeat_interval: z.number().int().positive(),
    timeout_ms: z.number().int().positive(),
  }),
  z.object({ op: z.literal("nonce_proof"), encrypted_nonce: z.string().min(1) }),
  z.object({ op: z.literal("pending_remote_init"), fingerprint: z.string().regex(/^[A-Za-z0-9_-]+$/) }),
  z.object({ op: z.literal("pending_ticket"), encrypted_user_payload: z.string().min(1) }),
  z.object({ op: z.literal("pending_login"), ticket: z.string().min(1) }),
  z.object({ op: z.literal("cancel") }),
  z.object({ op: z.literal("heartbeat_ack") }),
]);
type GatewayMessage = z.infer<typeof GatewayMessageSchema>;

const KNOWN_OPS: ReadonlySet<string> = new Set(GatewayMessageSchema.options.map((option) => option.shape.op.value));

const LoginResponseSchema = z.object({ encrypted_token: z.string().min(1) });
const CAPTCHA_FIELDS = ["captcha_key", "captcha_sitekey", "captcha_service", "captcha_rqtoken"] as const;

/**
 * Where the handshake is. `hello` is required before anything else; the QR
 * exists from `waitingForScan`; `redeeming` means the phone approved and the
 * socket is no longer needed.
 */
type Stage =
  | { readonly kind: "connecting" }
  | { readonly kind: "handshaking" }
  | { readonly kind: "waitingForScan"; readonly fingerprint: string }
  | { readonly kind: "waitingForApproval"; readonly user: DiscordUser }
  | { readonly kind: "redeeming" }
  | { readonly kind: "finished" };

const generateRsaKeys = (): Promise<{ publicKey: KeyObject; privateKey: KeyObject }> =>
  new Promise((resolve, reject) => {
    generateKeyPair("rsa", { modulusLength: 2048 }, (error, publicKey, privateKey) => {
      if (error) reject(error);
      else resolve({ publicKey, privateKey });
    });
  });

const decrypt = (privateKey: KeyObject, base64: string): Buffer =>
  privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(base64, "base64"),
  );

/** base64url(sha256(nonce)) with no padding. */
const nonceProof = (nonce: Buffer): string => createHash("sha256").update(nonce).digest("base64url");

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const captchaIn = (body: unknown): RemoteAuthCaptchaError | null => {
  if (typeof body !== "object" || body === null) return null;
  if (!CAPTCHA_FIELDS.some((field) => field in body)) return null;
  const service = "captcha_service" in body && typeof body.captcha_service === "string" ? body.captcha_service : null;
  return new RemoteAuthCaptchaError({
    service,
    message:
      "Discord asked for a captcha before finishing the login, and discord-mcp cannot show one. Nothing was saved. Wait a while and scan a new code; if it keeps asking, log in to Discord in a browser on this network first.",
  });
};

/** Exchanges the approved ticket for the account's token, then reads the account with it. */
const redeem = async (
  deps: RemoteAuthDeps,
  privateKey: KeyObject,
  ticket: string,
): Promise<Result<{ token: string; user: DiscordUser }, RemoteAuthError>> => {
  const network = (operation: string) =>
    new RemoteAuthNetworkError({
      operation,
      message: "discord-mcp could not reach Discord to finish the login. Nothing was saved; scan a new code to try again.",
    });

  const login = await Result.tryPromise({
    try: () =>
      deps.fetch(`${DiscordWebClient.apiBase}/users/@me/remote-auth/login`, {
        method: "POST",
        headers: { ...DiscordWebClient.browserHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
      }),
    catch: () => network("redeem login ticket"),
  });
  if (login.isErr()) return Result.err(login.error);
  const loginBody = await readJson(login.value);
  const captcha = captchaIn(loginBody);
  if (captcha) return Result.err(captcha);
  if (!login.value.ok) {
    return Result.err(
      new RemoteAuthHttpError({
        operation: "redeem login ticket",
        status: login.value.status,
        message: `Discord refused to finish the login (HTTP ${login.value.status}). Nothing was saved; scan a new code to try again.`,
      }),
    );
  }
  const parsed = LoginResponseSchema.safeParse(loginBody);
  if (!parsed.success) {
    return Result.err(
      new RemoteAuthProtocolError({
        stage: "redeeming",
        reason: "login response has no encrypted_token",
        message: "Discord finished the login with an answer discord-mcp does not understand. Nothing was saved; scan a new code to try again.",
      }),
    );
  }
  const token = Result.try({
    try: () => decrypt(privateKey, parsed.data.encrypted_token).toString("utf8"),
    catch: () =>
      new RemoteAuthProtocolError({
        stage: "redeeming",
        reason: "encrypted_token does not decrypt",
        message: "The login token from Discord could not be decrypted. Nothing was saved; scan a new code to try again.",
      }),
  });
  if (token.isErr()) return Result.err(token.error);
  if (token.value.trim() === "") {
    return Result.err(
      new RemoteAuthProtocolError({
        stage: "redeeming",
        reason: "empty token",
        message: "Discord returned an empty login token. Nothing was saved; scan a new code to try again.",
      }),
    );
  }

  const me = await Result.tryPromise({
    try: () => deps.fetch(`${DiscordWebClient.apiBase}/users/@me`, { headers: DiscordWebClient.authorizedHeaders(token.value) }),
    catch: () => network("verify token"),
  });
  if (me.isErr()) return Result.err(me.error);
  const meBody = await readJson(me.value);
  if (!me.value.ok) {
    return Result.err(
      new RemoteAuthHttpError({
        operation: "verify token",
        status: me.value.status,
        message: `Discord did not accept the new login (HTTP ${me.value.status}). Nothing was saved; scan a new code to try again.`,
      }),
    );
  }
  const user = DiscordUser.fromApi(meBody);
  if (user === null) {
    return Result.err(
      new RemoteAuthProtocolError({
        stage: "redeeming",
        reason: "unexpected /users/@me response",
        message: "Discord described the account in a way discord-mcp does not understand. Nothing was saved; scan a new code to try again.",
      }),
    );
  }
  return Result.ok({ token: token.value, user });
};

const run = async (
  deps: RemoteAuthDeps,
  options: RemoteAuthRunOptions,
): Promise<Result<RemoteAuthOutcome, RemoteAuthError>> => {
  const { signal, onProgress } = options;
  if (signal.aborted) return Result.ok({ kind: "aborted" });
  // Before the socket opens, so every message is handled synchronously.
  const { publicKey, privateKey } = await generateRsaKeys();
  if (signal.aborted) return Result.ok({ kind: "aborted" });

  return new Promise((resolve) => {
    let stage: Stage = { kind: "connecting" };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let expiresAt = 0;
    // Assigned right after the handlers below exist; events never arrive before openSocket returns.
    const connection: { socket?: RemoteAuthSocket } = {};

    const stopTimers = () => {
      clearInterval(heartbeat);
      clearTimeout(expiry);
    };
    const finish = (result: Result<RemoteAuthOutcome, RemoteAuthError>) => {
      if (stage.kind === "finished") return;
      stage = { kind: "finished" };
      stopTimers();
      signal.removeEventListener("abort", onAbort);
      connection.socket?.close();
      resolve(result);
    };
    const protocolError = (reason: string) =>
      finish(
        Result.err(
          new RemoteAuthProtocolError({
            stage: stage.kind,
            reason,
            message: "Discord's login service sent something discord-mcp does not understand. Nothing was saved; a new code is needed.",
          }),
        ),
      );
    const send = (payload: Record<string, unknown>) => connection.socket?.send(JSON.stringify(payload));
    const onAbort = () => finish(Result.ok({ kind: "aborted" }));

    const handle = (message: GatewayMessage) => {
      switch (message.op) {
        case "heartbeat_ack":
          return;
        case "hello": {
          if (stage.kind !== "connecting") return protocolError("hello twice");
          stage = { kind: "handshaking" };
          heartbeat = setInterval(() => send({ op: "heartbeat" }), message.heartbeat_interval);
          expiry = setTimeout(() => finish(Result.ok({ kind: "expired" })), message.timeout_ms);
          expiresAt = deps.now() + message.timeout_ms;
          send({ op: "init", encoded_public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64") });
          return;
        }
        case "nonce_proof": {
          if (stage.kind !== "handshaking") return protocolError("nonce_proof out of order");
          const nonce = Result.try(() => decrypt(privateKey, message.encrypted_nonce));
          if (nonce.isErr()) return protocolError("nonce does not decrypt");
          send({ op: "nonce_proof", proof: nonceProof(nonce.value) });
          return;
        }
        case "pending_remote_init": {
          if (stage.kind !== "handshaking") return protocolError("pending_remote_init out of order");
          stage = { kind: "waitingForScan", fingerprint: message.fingerprint };
          onProgress({ kind: "qr", url: `${QR_URL_BASE}${message.fingerprint}`, expiresAt });
          return;
        }
        case "pending_ticket": {
          if (stage.kind !== "waitingForScan") return protocolError("pending_ticket out of order");
          const payload = Result.try(() => decrypt(privateKey, message.encrypted_user_payload).toString("utf8"));
          const user = payload.isOk() ? DiscordUser.fromRemoteAuthPayload(payload.value) : null;
          if (user === null) return protocolError("user payload does not decrypt or parse");
          stage = { kind: "waitingForApproval", user };
          onProgress({ kind: "scanned", user });
          return;
        }
        case "pending_login": {
          if (stage.kind !== "waitingForApproval" && stage.kind !== "waitingForScan") {
            return protocolError("pending_login out of order");
          }
          stage = { kind: "redeeming" };
          stopTimers();
          connection.socket?.close();
          void redeem(deps, privateKey, message.ticket).then((redeemed) => {
            if (signal.aborted) return finish(Result.ok({ kind: "aborted" }));
            finish(redeemed.map(({ token, user }) => ({ kind: "loggedIn", token, user })));
          });
          return;
        }
        case "cancel":
          if (stage.kind === "redeeming") return;
          return finish(Result.ok({ kind: "cancelled" }));
      }
    };

    connection.socket = deps.openSocket(
      DiscordWebClient.remoteAuthGateway,
      { origin: DiscordWebClient.origin, "user-agent": DiscordWebClient.userAgent },
      {
        onMessage: (text) => {
          if (stage.kind === "finished") return;
          const json = Result.try((): unknown => JSON.parse(text));
          if (json.isErr()) return protocolError("message is not JSON");
          const op = typeof json.value === "object" && json.value !== null && "op" in json.value ? json.value.op : undefined;
          // Ops added later are ignored rather than ending the login.
          if (typeof op !== "string" || !KNOWN_OPS.has(op)) return;
          const parsed = GatewayMessageSchema.safeParse(json.value);
          if (!parsed.success) return protocolError(`malformed ${op}`);
          handle(parsed.data);
        },
        onClose: (code) => {
          switch (stage.kind) {
            case "finished":
            case "redeeming":
              return;
            case "waitingForScan":
            case "waitingForApproval":
              return finish(Result.ok({ kind: "expired" }));
            case "connecting":
            case "handshaking":
              return finish(
                Result.err(
                  new RemoteAuthConnectionError({
                    closeCode: code,
                    message:
                      "Discord's login service closed the connection before showing a code. Check that discord-mcp can reach discord.gg, then try again.",
                  }),
                ),
              );
          }
        },
      },
    );
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

/** The production transport: a `ws` WebSocket (it can send Origin and User-Agent). */
const openWebSocket: OpenRemoteAuthSocket = (url, headers, events) => {
  const ws = new WebSocket(url, { headers: { ...headers } });
  ws.on("message", (data) => events.onMessage(data.toString()));
  ws.on("close", (code) => events.onClose(code));
  // `close` always follows `error` in ws; the close handler decides.
  ws.on("error", () => undefined);
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: () => {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) ws.close(1000);
    },
  };
};

const liveDeps = (): RemoteAuthDeps => ({
  openSocket: openWebSocket,
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
});

export const RemoteAuth = {
  run,
  liveDeps,
  qrUrlBase: QR_URL_BASE,
  /** Exported for the fake gateway in tests. */
  nonceProof,
} as const;
