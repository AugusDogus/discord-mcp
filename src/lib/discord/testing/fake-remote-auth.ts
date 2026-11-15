import { Result } from "better-result";
/**
 * A scripted remote-auth gateway and Discord HTTP API for tests: it plays the
 * server side of src/lib/discord/remote-auth.ts with real RSA-OAEP under the
 * client's public key. Never imported by app code.
 */
import { constants, createPublicKey, publicEncrypt, type KeyObject } from "node:crypto";
import { z } from "zod";
import { RemoteAuth, type RemoteAuthDeps, type RemoteAuthSocketEvents } from "../remote-auth";

export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

const InitSchema = z.object({ op: z.literal("init"), encoded_public_key: z.string() });
const ProofSchema = z.object({ op: z.literal("nonce_proof"), proof: z.string() });

export class FakeRemoteAuthGateway {
  readonly sent: string[] = [];
  readonly requests: { url: string; init: RequestInit }[] = [];
  closedByClient = false;
  headers: Readonly<Record<string, string>> = {};
  #events: RemoteAuthSocketEvents | null = null;
  #publicKey: KeyObject | null = null;
  #opened: () => void = () => undefined;
  readonly opened = new Promise<void>((resolve) => {
    this.#opened = resolve;
  });

  constructor(private readonly fetchHandler: FetchHandler = () => new Response(null, { status: 500 })) {}

  deps(now: () => number = () => 1_000_000): RemoteAuthDeps {
    return {
      now,
      fetch: async (url, init) => {
        this.requests.push({ url, init });
        return this.fetchHandler(url, init);
      },
      openSocket: (_url, headers, events) => {
        this.headers = headers;
        this.#events = events;
        queueMicrotask(this.#opened);
        return Result.ok({
          send: (text) => {
            this.sent.push(text);
          },
          close: () => {
            this.closedByClient = true;
          },
        });
      },
    };
  }

  /** Delivers a gateway message on a later tick, like a real socket. */
  push(message: Record<string, unknown> | string): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(() => {
        this.#events?.onMessage(typeof message === "string" ? message : JSON.stringify(message));
        resolve();
      }, 0),
    );
  }

  closeFromServer(code = 1000): void {
    this.#events?.onClose(code);
  }

  encrypt(plaintext: string | Buffer): string {
    if (this.#publicKey === null) throw new Error("the client has not sent init yet");
    return publicEncrypt(
      { key: this.#publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      typeof plaintext === "string" ? Buffer.from(plaintext) : plaintext,
    ).toString("base64");
  }

  sentOps(): string[] {
    return this.sent.map((text) => z.object({ op: z.string() }).parse(JSON.parse(text)).op);
  }

  async waitForSent(op: string): Promise<string> {
    for (let i = 0; i < 200; i += 1) {
      const found = this.sent.find((text) => z.object({ op: z.string() }).parse(JSON.parse(text)).op === op);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`the client never sent ${op}`);
  }

  /** hello -> init -> nonce_proof (checked) -> pending_remote_init. Returns whether the proof was right. */
  async handshake(options: { fingerprint?: string; timeoutMs?: number; heartbeatMs?: number } = {}): Promise<boolean> {
    await this.opened;
    await this.push({ op: "hello", heartbeat_interval: options.heartbeatMs ?? 41_250, timeout_ms: options.timeoutMs ?? 120_000 });
    const init = InitSchema.parse(JSON.parse(await this.waitForSent("init")));
    this.#publicKey = createPublicKey({ key: Buffer.from(init.encoded_public_key, "base64"), format: "der", type: "spki" });
    const nonce = Buffer.from("a-random-nonce-from-discord");
    await this.push({ op: "nonce_proof", encrypted_nonce: this.encrypt(nonce) });
    const proof = ProofSchema.parse(JSON.parse(await this.waitForSent("nonce_proof")));
    await this.push({ op: "pending_remote_init", fingerprint: options.fingerprint ?? "fp_abc123" });
    return proof.proof === RemoteAuth.nonceProof(nonce);
  }
}

export const DiscordApiFakes = {
  me: { id: "123", username: "alice", global_name: "Alice", discriminator: "0", avatar: "avatarhash" },
  json: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
} as const;

/** Remote-auth deps that open a new fake gateway per connection (several QR codes in a row). */
export const fakeGatewaySequence = (handlerFor: (gateway: FakeRemoteAuthGateway) => FetchHandler) => {
  const gateways: FakeRemoteAuthGateway[] = [];
  const deps: RemoteAuthDeps = {
    now: () => Date.now(),
    fetch: async (url, init) => {
      const latest = gateways[gateways.length - 1];
      return latest ? latest.deps().fetch(url, init) : new Response(null, { status: 500 });
    },
    openSocket: (url, headers, events) => {
      const gateway: FakeRemoteAuthGateway = new FakeRemoteAuthGateway((u, i) => handlerFor(gateway)(u, i));
      gateways.push(gateway);
      return gateway.deps().openSocket(url, headers, events);
    },
  };
  const nth = async (index: number): Promise<FakeRemoteAuthGateway> => {
    for (let i = 0; i < 400; i += 1) {
      const gateway = gateways[index];
      if (gateway) return gateway;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no gateway connection #${index}`);
  };
  return { deps, gateways, nth } as const;
};
