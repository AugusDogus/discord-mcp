import { Result, TaggedError } from "better-result";
import { z } from "zod";
import { DiscordWebClient } from "./web-client";

export class DiscordApiError extends TaggedError("DiscordApiError")<{
  operation: string;
  status: number | null;
  message: string;
}> {}

export type DiscordFetch = (url: string, init: RequestInit) => Promise<Response>;
export type DiscordRestDeps = {
  readonly fetch: DiscordFetch;
  readonly rejected: () => Promise<Result<unknown, { readonly message: string }>>;
};
export type RestOptions = {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly query?: URLSearchParams;
};

const error = (operation: string, status: number | null, message: string) =>
  new DiscordApiError({ operation, status, message });

const create = (token: string, deps: DiscordRestDeps) => {
  let rejected = false;
  const request = async <T>(
    operation: string,
    path: string,
    schema: z.ZodType<T>,
    options: RestOptions = {},
  ): Promise<Result<T, DiscordApiError>> => {
    if (rejected)
      return Result.err(error(operation, 401, "Discord rejected this login. Log in again from the dashboard."));
    if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
      return Result.err(error(operation, null, "The Discord request path is invalid. Nothing was sent."));
    }
    const response = await Result.tryPromise({
      try: () =>
        deps.fetch(`${DiscordWebClient.apiBase}${path}${options.query?.size ? `?${options.query}` : ""}`, {
          method: options.method ?? "GET",
          headers: { ...DiscordWebClient.authorizedHeaders(token), "content-type": "application/json" },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
        }),
      catch: () =>
        error(
          operation,
          null,
          `Could not ${operation}: Discord did not respond. A write may have reached Discord; check the target before retrying.`,
        ),
    });
    if (response.isErr()) return response;
    const { status } = response.value;
    if (status === 401) {
      rejected = true;
      const marked = await deps.rejected();
      return Result.err(
        error(
          operation,
          status,
          marked.isErr()
            ? `Discord rejected the login, and its status could not be saved. ${marked.error.message}`
            : "Discord rejected the login. Log in again from the discord-mcp dashboard; no further requests will be sent with this login.",
        ),
      );
    }
    if (!response.value.ok) {
      const hint =
        status === 429
          ? "Discord rate limited the request. Wait before retrying."
          : status === 403
            ? "Discord denied access. Check the account's channel permissions or complete any verification in Discord."
            : status === 404
              ? "The Discord target was not found. Check its ID and the account's access."
              : "Check the target in Discord before retrying; a write may already have reached it.";
      // Never echo Discord's body, headers or a transport exception: they can contain credentials.
      return Result.err(error(operation, status, `Could not ${operation}: Discord returned HTTP ${status}. ${hint}`));
    }
    const json =
      status === 204
        ? Result.ok(null)
        : await Result.tryPromise({
            try: async (): Promise<unknown> => response.value.json(),
            catch: () =>
              error(
                operation,
                status,
                `Discord accepted the request to ${operation}, but its response was unreadable. Check Discord before retrying a write.`,
              ),
          });
    if (json.isErr()) return json;
    const parsed = schema.safeParse(json.value);
    return parsed.success
      ? Result.ok(parsed.data)
      : Result.err(
          error(
            operation,
            status,
            `Discord accepted the request to ${operation}, but returned an unexpected response. Check Discord before retrying a write.`,
          ),
        );
  };
  return { request } as const;
};

export type DiscordRest = ReturnType<typeof create>;
export const DiscordRest = { create, error } as const;
