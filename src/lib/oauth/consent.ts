import { randomBytes } from "node:crypto";
import { Result } from "better-result";
import { DiscordAccountStore, type DiscordAccountStorageError } from "@/lib/discord/account-store";
import { DiscordUser } from "@/lib/discord/user";
import type { VaultStorageError } from "@/lib/vault";
import { keySlot, oauthGrant } from "@/lib/db/vault-schema";
import { Base64Url } from "@/lib/vault/base64url";
import { KeySlot } from "@/lib/vault/key-slot";
import { AuthorizationRequest, type ValidatedAuthorization } from "./authorization-request";
import { AuthorizeEndpoint } from "./authorize";
import { ConsentTicket } from "./consent-ticket";
import type { BrowserSession, OAuthContext } from "./context";
import { OAuthErrors, type OAuthStorageError } from "./errors";
import { OAuthHttp } from "./http";
import { OAuthLog } from "./log";
import { McpScope } from "./scopes";
import { AUTHORIZATION_CODE_TTL_MS, AuthorizationCode } from "./tokens";

/** A Discord account the connection can act as, as the consent page shows it. */
export type ConsentAccount = {
  readonly id: string;
  readonly name: string;
  readonly handle: string;
  readonly avatarUrl: string;
};

/**
 * What the consent page renders. `login`: the user has no logged-in Discord
 * account yet; log in first, then this request resumes. `ready` lists the
 * accounts the connection can use; with one, there is nothing to choose.
 */
export type ConsentView =
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "sign_in"; readonly signInUrl: string }
  | { readonly kind: "login"; readonly loginUrl: string }
  | {
      readonly kind: "ready";
      readonly clientName: string;
      readonly redirectHost: string;
      readonly scopes: readonly McpScope[];
      readonly accounts: readonly [ConsentAccount, ...ConsentAccount[]];
      readonly ticket: string;
    };

/** The user's logged-in accounts a grant can be bound to: readable and not rejected by Discord. */
const accountsOf = async (
  ctx: OAuthContext,
  userId: string,
): Promise<Result<ConsentAccount[], DiscordAccountStorageError | VaultStorageError>> => {
  const listed = await DiscordAccountStore.listWith(ctx.db, ctx.vault, userId);
  if (listed.isErr()) return listed;
  return Result.ok(
    listed.value.flatMap((entry) =>
      entry.kind === "readable" && entry.record.status === "active"
        ? [
            {
              id: entry.record.id,
              name: DiscordUser.displayName(entry.record.user),
              handle: DiscordUser.handle(entry.record.user),
              avatarUrl: DiscordUser.avatarUrl(entry.record.user),
            },
          ]
        : [],
    ),
  );
};

const UNAVAILABLE_MESSAGE =
  "discord-mcp could not load this request right now. Nothing was shared. Reload the page to try again.";

/** Host (or scheme for custom-scheme apps) the user will be sent back to. */
const redirectHostOf = (redirectUri: string): string => {
  const url = new URL(redirectUri);
  return url.host !== "" ? url.host : url.protocol;
};

/** Loads the consent page state for the authorization request in `params`. */
const load = async (ctx: OAuthContext, params: URLSearchParams, headers: Headers): Promise<ConsentView> => {
  const validated = await AuthorizationRequest.validate(ctx, params);
  if (validated.isErr()) {
    const error = validated.error;
    switch (error._tag) {
      case "AuthorizeFatalError":
        return { kind: "invalid", message: error.message };
      case "AuthorizeRedirectError":
        return {
          kind: "invalid",
          message: `This authorization request is invalid: ${error.description} Nothing was shared. Return to the app you were connecting and start again.`,
        };
      case "OAuthStorageError":
        OAuthLog.failure(error.operation, error.cause);
        return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
    }
  }
  const { request, client } = validated.value;
  const session = await AuthorizeEndpoint.sessionOf(ctx, headers);
  if (session.isErr()) return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
  const authorize = `/oauth/authorize?${AuthorizationRequest.toSearchParams(request).toString()}`;
  if (session.value === null) return { kind: "sign_in", signInUrl: AuthorizeEndpoint.signInUrl(authorize) };
  const accounts = await accountsOf(ctx, session.value.userId);
  if (accounts.isErr()) {
    OAuthLog.failure(accounts.error.operation, accounts.error.cause);
    return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
  }
  const [first, ...rest] = accounts.value;
  if (first === undefined) return { kind: "login", loginUrl: `/dashboard/login?${new URLSearchParams({ next: authorize }).toString()}` };
  return {
    kind: "ready",
    clientName: client.clientName,
    redirectHost: redirectHostOf(request.redirectUri),
    scopes: request.scopes,
    accounts: [first, ...rest],
    ticket: ConsentTicket.issue(ctx, session.value, request),
  };
};

/** Creates the grant, bound to `discordAccountId`, and a 60 s single-use oauth_code slot; returns the code string. */
const issueCode = async (
  ctx: OAuthContext,
  session: BrowserSession,
  authorization: ValidatedAuthorization,
  discordAccountId: string,
): Promise<Result<string, OAuthStorageError>> => {
  const now = ctx.vault.now();
  const { request } = authorization;
  const grantId = Base64Url.encode(randomBytes(16));
  const code = KeySlot.mint(ctx.vault, {
    userId: session.userId,
    kind: "oauth_code",
    grantId,
    expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
    payloadJson: JSON.stringify({
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: McpScope.format(request.scopes),
      resource: request.resource,
    }),
  });
  const stored = await Result.tryPromise({
    try: () =>
      ctx.db.batch([
        ctx.db.insert(oauthGrant).values({
          id: grantId,
          userId: session.userId,
          discordAccountId,
          clientId: request.clientId,
          scope: McpScope.format(request.scopes),
          createdAt: now,
        }),
        ctx.db.insert(keySlot).values(code.values),
      ]),
    catch: (cause) => OAuthErrors.storage(`create grant and authorization code for client ${request.clientId}`, cause),
  });
  if (stored.isErr()) return Result.err(stored.error);
  return Result.ok(AuthorizationCode.format(code.credential));
};

/**
 * POST /oauth/consent/decision (form: ticket, decision=approve|deny, and
 * account=<discord_account id> to approve).
 * CSRF: the Origin must be ours and the ticket must be valid, unexpired,
 * unused and bound to the current Better Auth session.
 */
const decide = async (ctx: OAuthContext, request: Request): Promise<Response> => {
  if (request.headers.get("origin") !== ctx.origin) {
    return OAuthHttp.htmlError(403, "Request blocked", "This approval did not come from the discord-mcp consent page. Nothing was shared.");
  }
  const form = await OAuthHttp.readForm(request);
  if (form.isErr()) return OAuthHttp.htmlError(400, "Cannot process approval", `${form.error.description} Nothing was shared.`);
  const ticket = form.value.get("ticket");
  const decision = form.value.get("decision");
  if (ticket === undefined || (decision !== "approve" && decision !== "deny")) {
    return OAuthHttp.htmlError(400, "Cannot process approval", "The approval form is incomplete. Nothing was shared. Return to the app you were connecting and start again.");
  }
  const session = await AuthorizeEndpoint.sessionOf(ctx, request.headers);
  if (session.isErr()) return OAuthHttp.htmlError(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
  if (session.value === null) {
    return OAuthHttp.htmlError(401, "Signed out", "Your discord-mcp session ended before you approved. Nothing was shared. Return to the app you were connecting and start again.");
  }
  const claims = ConsentTicket.verify(ctx, ticket, session.value);
  if (claims.isErr()) return OAuthHttp.htmlError(400, "Approval expired", claims.error.message);
  // Choose the account before consuming the ticket, so a missing choice can be retried.
  let choice: { readonly decision: "deny" } | { readonly decision: "approve"; readonly discordAccountId: string } = { decision: "deny" };
  if (decision === "approve") {
    const accounts = await accountsOf(ctx, session.value.userId);
    if (accounts.isErr()) {
      OAuthLog.failure(accounts.error.operation, accounts.error.cause);
      return OAuthHttp.htmlError(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
    }
    const chosen = form.value.get("account");
    const account = accounts.value.find((candidate) => candidate.id === chosen);
    if (account === undefined)
      return OAuthHttp.htmlError(
        400,
        "Choose a Discord account",
        accounts.value.length === 0
          ? "No Discord account is logged in to discord-mcp. Nothing was shared. Log in to Discord from the dashboard, then return to the app you were connecting and start again."
          : "Choose which logged-in Discord account this connection uses. Nothing was shared. Go back to the approval page and pick an account.",
      );
    choice = { decision: "approve", discordAccountId: account.id };
  }
  const consumed = await ConsentTicket.consume(ctx, claims.value);
  if (consumed.isErr()) {
    if (consumed.error._tag === "OAuthStorageError") {
      OAuthLog.failure(consumed.error.operation, consumed.error.cause);
      return OAuthHttp.htmlError(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
    }
    return OAuthHttp.htmlError(400, "Approval already used", consumed.error.message);
  }

  // Re-check against the current registration (the client may have changed since the page loaded).
  const validated = await AuthorizationRequest.validate(ctx, AuthorizationRequest.toSearchParams(claims.value.request));
  if (validated.isErr()) {
    const error = validated.error;
    switch (error._tag) {
      case "AuthorizeFatalError":
        return OAuthHttp.htmlError(400, "Cannot authorize this app", error.message);
      case "AuthorizeRedirectError":
        return OAuthHttp.seeOther(AuthorizationRequest.errorUrl(ctx, error));
      case "OAuthStorageError":
        OAuthLog.failure(error.operation, error.cause);
        return OAuthHttp.htmlError(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
    }
  }
  const authorization = validated.value;
  const { request: authRequest } = authorization;

  if (choice.decision === "deny") {
    return OAuthHttp.seeOther(
      AuthorizationRequest.responseUrl(ctx, authRequest.redirectUri, {
        error: "access_denied",
        error_description: "The user denied access.",
        state: authRequest.state,
      }),
    );
  }

  const code = await issueCode(ctx, session.value, authorization, choice.discordAccountId);
  if (code.isErr()) {
    OAuthLog.failure(code.error.operation, code.error.cause);
    return OAuthHttp.htmlError(503, "Authorization unavailable", UNAVAILABLE_MESSAGE);
  }
  return OAuthHttp.seeOther(
    AuthorizationRequest.responseUrl(ctx, authRequest.redirectUri, {
      code: code.value,
      state: authRequest.state,
    }),
  );
};

export const ConsentFlow = { load, decide, redirectHostOf } as const;
