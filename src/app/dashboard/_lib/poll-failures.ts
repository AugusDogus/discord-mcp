/**
 * When the login page stops waiting for discord-mcp. Phones suspend a tab
 * that is in the background (for example while you approve the login in the
 * Discord app), so failed checks then are expected and never end the login;
 * only checks failing for 20 seconds while the page is visible do.
 */
export type PollFailures = { readonly kind: "none" } | { readonly kind: "failing"; readonly since: number };

const GIVE_UP_AFTER_MS = 20_000;
const none: PollFailures = { kind: "none" };

const record = (
  failures: PollFailures,
  at: number,
  visibility: DocumentVisibilityState,
): { readonly failures: PollFailures; readonly giveUp: boolean } => {
  if (visibility === "hidden") return { failures: none, giveUp: false };
  if (failures.kind === "none") return { failures: { kind: "failing", since: at }, giveUp: false };
  return { failures, giveUp: at - failures.since >= GIVE_UP_AFTER_MS };
};

export const PollFailures = { none, record } as const;
