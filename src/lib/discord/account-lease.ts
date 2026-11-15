/** Serializes one user's agent actions, QR saves, settings and logout in this single-process app. */
const create = () => {
  const tails = new Map<string, Promise<void>>();
  const run = async <T>(userId: string, action: () => Promise<T>): Promise<T> => {
    const previous = tails.get(userId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    tails.set(userId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (tails.get(userId) === tail) tails.delete(userId);
    }
  };
  return { run } as const;
};
const key = Symbol.for("discord-mcp.account-lease");
type LeaseGlobal = typeof globalThis & { [key]?: ReturnType<typeof create> };
const global: LeaseGlobal = globalThis;
global[key] ??= create();
export const DiscordAccountLease = { create, run: global[key].run } as const;
