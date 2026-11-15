import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "better-result";
import { Env } from "./env";

type Source = Readonly<Record<string, string | undefined>>;
type StartupError = { readonly message: string };
const secret = async (
  directory: string,
  name: string,
  override: string | undefined,
): Promise<Result<string, StartupError>> => {
  if (override !== undefined && override !== "") return Result.ok(override);
  const path = join(directory, name);
  // Exclusive creation preserves existing secrets, including on concurrent starts.
  const created = await Result.tryPromise({
    try: () => writeFile(path, randomBytes(32).toString("base64"), { flag: "wx", mode: 0o600 }),
    catch: (cause: unknown) => cause,
  });
  if (
    created.isErr() &&
    !(created.error instanceof Error && "code" in created.error && created.error.code === "EEXIST")
  )
    return Result.err({
      message: `Could not create ${name} in the data directory. Check /data ownership and free space; existing secrets were preserved.`,
    });
  return Result.tryPromise({
    try: async () => (await readFile(path, "utf8")).trim(),
    catch: () => ({
      message: `Could not read ${name} from /data/secrets. Check its permissions; the file was preserved.`,
    }),
  });
};
const prepare = async (dataDir: string, source: Source): Promise<Result<void, StartupError>> => {
  const url = Result.try({ try: () => new URL(source.DISCORD_MCP_URL ?? ""), catch: () => null });
  if (
    url.isErr() ||
    !["http:", "https:"].includes(url.value.protocol) ||
    url.value.username ||
    url.value.password ||
    url.value.search ||
    url.value.hash ||
    url.value.pathname !== "/"
  )
    return Result.err({
      message:
        "Set DISCORD_MCP_URL to the Tailscale Serve origin, for example https://myserver.example-tailnet.ts.net:6443. It must have no path, query or credentials.",
    });
  const directory = join(dataDir, "secrets");
  const made = await Result.tryPromise({
    try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
    catch: () => ({
      message: "Could not create /data/secrets. Check the mounted directory's PUID/PGID ownership and free space.",
    }),
  });
  if (made.isErr()) return made;
  const pepper = await secret(directory, "key-pepper", source.KEY_PEPPER);
  if (pepper.isErr()) return pepper;
  const auth = await secret(directory, "auth-secret", source.BETTER_AUTH_SECRET);
  if (auth.isErr()) return auth;
  const validPepper = Env.parseVault({ KEY_PEPPER: pepper.value });
  if (validPepper.isErr()) return Result.err(validPepper.error);
  const validAuth = Env.parseAuth({ BETTER_AUTH_URL: url.value.origin, BETTER_AUTH_SECRET: auth.value });
  if (validAuth.isErr()) return Result.err(validAuth.error);
  return Result.ok(undefined);
};
export const SelfHosting = { prepare } as const;
