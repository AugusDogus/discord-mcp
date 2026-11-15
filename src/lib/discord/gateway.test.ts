import { expect, test } from "bun:test";
import { Result } from "better-result";
import { BunWebSocketUnavailableError } from "./bun-websocket";
import { DiscordGateway, type GatewaySocketEvents } from "./gateway";

const harness = () => {
  let events: GatewaySocketEvents | undefined;
  const sent: unknown[] = [];
  let closed = 0;
  const connect = DiscordGateway.connectWith((handlers) => {
    events = handlers;
    return Result.ok({
      send: (data) => {
        sent.push(JSON.parse(data));
      },
      close: () => {
        closed++;
      },
    });
  }, 100);
  const emit = (data: unknown) => events?.message(JSON.stringify(data));
  return { connect, emit, sent, closed: () => closed, close: (code: number) => events?.closed(code) };
};
test("gateway identifies invisible, accepts READY, uses only session presence and closes on abort", async () => {
  const h = harness();
  const controller = new AbortController();
  const result = h.connect("test-token-not-real", "invisible", controller.signal);
  h.emit({ op: 10, d: { heartbeat_interval: 1_000 } });
  expect(h.sent[0]).toMatchObject({ op: 2, d: { presence: { status: "invisible" } } });
  h.emit({ op: 0, t: "READY", s: 1, d: { session_id: "test-session" } });
  const session = (await result).unwrap();
  expect(session.sessionId).toBe("test-session");
  session.setStatus("online");
  expect(h.sent[1]).toMatchObject({ op: 3, d: { status: "online" } });
  controller.abort();
  expect(session.alive()).toBe(false);
  expect(h.closed()).toBe(1);
});
test("gateway rejection and invalid handshakes are errors and close the socket", async () => {
  for (const fail of ["reject", "invalid", "abort"]) {
    const h = harness();
    const controller = new AbortController();
    const result = h.connect("test-token-not-real", "invisible", controller.signal);
    if (fail === "reject") h.close(4004);
    else if (fail === "invalid") h.emit({ op: 10, d: { heartbeat_interval: 0 } });
    else controller.abort();
    expect((await result).isErr()).toBe(true);
    expect(h.closed()).toBe(1);
  }
});

test("READY before the identify handshake cannot create an authenticated session", async () => {
  const h = harness();
  const result = h.connect("test-token-not-real", "invisible", new AbortController().signal);
  h.emit({ op: 0, t: "READY", d: { session_id: "test-session" } });
  const connected = await result;
  if (connected.isOk()) connected.value.close();
  expect(connected.isErr()).toBe(true);
});

test("a gateway socket that cannot open is an error with its reason", async () => {
  const connect = DiscordGateway.connectWith(
    () => Result.err(new BunWebSocketUnavailableError({ message: "discord-mcp must run on Bun." })),
    100,
  );
  const result = await connect("test-token-not-real", "invisible", new AbortController().signal);
  expect(result.match({ ok: () => null, err: (e) => e.message })).toBe("discord-mcp must run on Bun.");
});
