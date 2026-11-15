import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { RemoteAuth, RemoteAuthConnectionError, type RemoteAuthProgress } from "./remote-auth";
import { DiscordApiFakes, FakeRemoteAuthGateway, type FetchHandler } from "./testing/fake-remote-auth";

const TOKEN = "test-token-not-real";

const start = (gateway: FakeRemoteAuthGateway, controller = new AbortController()) => {
  const progress: RemoteAuthProgress[] = [];
  const result = RemoteAuth.run(gateway.deps(), { signal: controller.signal, onProgress: (p) => progress.push(p) });
  return { progress, result, controller };
};

/** Discord's HTTP side: the login exchange encrypts the token for the client, /users/@me describes the account. */
const discordApi = (gateway: () => FakeRemoteAuthGateway, login?: () => Response): FetchHandler => (url, init) => {
  if (url.endsWith("/users/@me/remote-auth/login")) {
    return login ? login() : DiscordApiFakes.json({ encrypted_token: gateway().encrypt(TOKEN) });
  }
  if (url.endsWith("/users/@me")) {
    const headers = new Headers(init.headers);
    return headers.get("authorization") === TOKEN
      ? DiscordApiFakes.json(DiscordApiFakes.me)
      : DiscordApiFakes.json({ message: "401: Unauthorized", code: 0 }, 401);
  }
  return new Response(null, { status: 404 });
};

const scannedPayload = "123:0:avatarhash:alice";

describe("remote auth", () => {
  test("hello, nonce proof, QR, scan, approval: logs in with the decrypted token", async () => {
    const gateway: FakeRemoteAuthGateway = new FakeRemoteAuthGateway(discordApi(() => gateway));
    const run = start(gateway);

    expect(await gateway.handshake({ fingerprint: "fp_123" })).toBe(true);
    expect(gateway.headers).toMatchObject({ origin: "https://discord.com" });
    expect(gateway.headers["user-agent"]).toContain("Chrome/");
    expect(run.progress).toEqual([{ kind: "qr", url: "https://discord.com/ra/fp_123", expiresAt: 1_000_000 + 120_000 }]);

    await gateway.push({ op: "pending_ticket", encrypted_user_payload: gateway.encrypt(scannedPayload) });
    expect(run.progress[1]).toEqual({
      kind: "scanned",
      user: { id: "123", username: "alice", globalName: null, discriminator: "0", avatar: "avatarhash" },
    });

    await gateway.push({ op: "pending_login", ticket: "ticket-1" });
    const outcome = (await run.result).unwrap();
    expect(outcome).toEqual({
      kind: "loggedIn",
      token: TOKEN,
      user: { id: "123", username: "alice", globalName: "Alice", discriminator: "0", avatar: "avatarhash" },
    });
    const login = gateway.requests[0];
    expect(login?.url).toBe("https://discord.com/api/v9/users/@me/remote-auth/login");
    expect(login?.init.body).toBe(JSON.stringify({ ticket: "ticket-1" }));
    expect(new Headers(login?.init.headers).get("origin")).toBe("https://discord.com");
    expect(gateway.closedByClient).toBe(true);
  });

  test("the public key is SPKI DER and the proof is unpadded base64url", async () => {
    const gateway = new FakeRemoteAuthGateway();
    const run = start(gateway);
    expect(await gateway.handshake()).toBe(true);
    const proof = gateway.sent.find((text) => text.includes('"nonce_proof"')) ?? "";
    expect(proof).not.toContain("=");
    expect(proof).not.toMatch(/[+/]/);
    run.controller.abort();
    expect((await run.result).unwrap()).toEqual({ kind: "aborted" });
  });

  test("heartbeats are sent every interval", async () => {
    const gateway = new FakeRemoteAuthGateway();
    const run = start(gateway);
    await gateway.handshake({ heartbeatMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(gateway.sentOps().filter((op) => op === "heartbeat").length).toBeGreaterThanOrEqual(2);
    run.controller.abort();
    await run.result;
  });

  test("cancel on the phone ends the run as cancelled", async () => {
    const gateway = new FakeRemoteAuthGateway();
    const run = start(gateway);
    await gateway.handshake();
    await gateway.push({ op: "pending_ticket", encrypted_user_payload: gateway.encrypt(scannedPayload) });
    await gateway.push({ op: "cancel" });
    expect((await run.result).unwrap()).toEqual({ kind: "cancelled" });
    expect(gateway.closedByClient).toBe(true);
  });

  test("the QR expires after timeout_ms", async () => {
    const gateway = new FakeRemoteAuthGateway();
    const run = start(gateway);
    await gateway.handshake({ timeoutMs: 20 });
    expect((await run.result).unwrap()).toEqual({ kind: "expired" });
  });

  test("the gateway closing after the QR is an expiry, before it a connection error", async () => {
    const shown = new FakeRemoteAuthGateway();
    const afterQr = start(shown);
    await shown.handshake();
    shown.closeFromServer(4003);
    expect((await afterQr.result).unwrap()).toEqual({ kind: "expired" });

    const early = new FakeRemoteAuthGateway();
    const beforeQr = start(early);
    await early.opened;
    early.closeFromServer(1006);
    const error = (await beforeQr.result).match({ ok: () => null, err: (e) => e });
    expect(error?._tag).toBe("RemoteAuthConnectionError");
  });

  test("a captcha when redeeming the ticket is a clear error and nothing else is requested", async () => {
    const gateway: FakeRemoteAuthGateway = new FakeRemoteAuthGateway(
      discordApi(
        () => gateway,
        () => DiscordApiFakes.json({ captcha_key: ["captcha-required"], captcha_sitekey: "x", captcha_service: "hcaptcha" }, 400),
      ),
    );
    const run = start(gateway);
    await gateway.handshake();
    await gateway.push({ op: "pending_ticket", encrypted_user_payload: gateway.encrypt(scannedPayload) });
    await gateway.push({ op: "pending_login", ticket: "ticket-1" });
    const error = (await run.result).match({ ok: () => null, err: (e) => e });
    expect(error?._tag).toBe("RemoteAuthCaptchaError");
    expect(error?.message).toContain("captcha");
    expect(gateway.requests).toHaveLength(1);
  });

  test("a token Discord then refuses is an HTTP error, not a login", async () => {
    const gateway: FakeRemoteAuthGateway = new FakeRemoteAuthGateway((url, init) =>
      url.endsWith("/remote-auth/login")
        ? DiscordApiFakes.json({ encrypted_token: gateway.encrypt("some-other-token") })
        : discordApi(() => gateway)(url, init),
    );
    const run = start(gateway);
    await gateway.handshake();
    await gateway.push({ op: "pending_login", ticket: "ticket-1" });
    const error = (await run.result).match({ ok: () => null, err: (e) => e });
    expect(error).toMatchObject({ _tag: "RemoteAuthHttpError", operation: "verify token", status: 401 });
  });

  test("messages out of order or undecryptable are protocol errors; unknown ops are ignored", async () => {
    const outOfOrder = new FakeRemoteAuthGateway();
    const a = start(outOfOrder);
    await outOfOrder.opened;
    await outOfOrder.push({ op: "future_op", anything: true });
    await outOfOrder.push({ op: "pending_login", ticket: "t" });
    expect((await a.result).match({ ok: () => null, err: (e) => e })).toMatchObject({
      _tag: "RemoteAuthProtocolError",
      reason: "pending_login out of order",
    });

    const garbage = new FakeRemoteAuthGateway();
    const b = start(garbage);
    await garbage.handshake();
    await garbage.push({ op: "pending_ticket", encrypted_user_payload: Buffer.from("not rsa").toString("base64") });
    expect((await b.result).match({ ok: () => null, err: (e) => e })?._tag).toBe("RemoteAuthProtocolError");
  });

  test("a socket that cannot open ends the run with its reason, and nothing is sent", async () => {
    const reason = "discord-mcp must run on Bun.";
    const result = await RemoteAuth.run(
      {
        openSocket: () => Result.err(new RemoteAuthConnectionError({ closeCode: null, message: reason })),
        fetch: async () => new Response(null, { status: 500 }),
        now: () => 0,
      },
      { signal: new AbortController().signal, onProgress: () => undefined },
    );
    expect(result.match({ ok: () => null, err: (e) => e })).toMatchObject({
      _tag: "RemoteAuthConnectionError",
      message: reason,
    });
  });
});
