import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "better-result";
import { LoginBrowserError } from "./error";

export type ColorScheme = "light" | "dark";
export type BrowserHandle = {
  readonly exited: Promise<void>;
  readonly hasExited: () => boolean;
  readonly close: () => Promise<Result<void, LoginBrowserError>>;
};
export type BrowserLauncher = (secret: string, colorScheme: ColorScheme) => Promise<Result<BrowserHandle, LoginBrowserError>>;

type Config = { readonly chromiumPath: string; readonly profileRoot: string; readonly extensionPath: string; readonly stopTimeoutMs: number };

const args = (profileDir: string, extensionDir: string, colorScheme: ColorScheme): string[] => [
  "--no-sandbox",
  "--password-store=basic",
  "--ozone-platform=wayland",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  `--user-data-dir=${profileDir}`,
  `--load-extension=${extensionDir}`,
  `--disable-extensions-except=${extensionDir}`,
  ...(colorScheme === "dark" ? ["--force-dark-mode", "--blink-settings=preferredColorScheme=0"] : ["--blink-settings=preferredColorScheme=1"]),
  "--kiosk",
  "https://discord.com/login",
];

const create = (config: Config): BrowserLauncher => async (secret, colorScheme) => {
  let profileDir: string | undefined;
  const launched = await Result.tryPromise({
    try: async (): Promise<BrowserHandle> => {
      await mkdir(config.profileRoot, { recursive: true, mode: 0o700 });
      // Only called with no active browser. Also removes profiles left by a server crash.
      for (const entry of await readdir(config.profileRoot)) {
        await rm(join(config.profileRoot, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
      profileDir = await mkdtemp(join(config.profileRoot, "profile-"));
      const directory = profileDir;
      const extensionDir = join(directory, "login-extension");
      await cp(config.extensionPath, extensionDir, { recursive: true });
      await writeFile(join(extensionDir, "config.json"), JSON.stringify({ secret }), { mode: 0o600 });
      // Chromium's crash handler otherwise uses ~/.config independently of
      // --user-data-dir. Keep its dumps and OS-level caches in the same RAM
      // directory so closing the browser removes them too.
      const child = spawn(config.chromiumPath, args(directory, extensionDir, colorScheme), {
        stdio: "ignore",
        env: {
          ...process.env,
          CHROME_CONFIG_HOME: join(directory, "config"),
          XDG_CONFIG_HOME: join(directory, "config"),
          XDG_CACHE_HOME: join(directory, "cache"),
        },
      });
      let done = false;
      const exited = new Promise<void>((resolve) => {
        const finish = () => { done = true; resolve(); };
        child.once("exit", finish);
        child.once("error", finish);
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      return {
        exited,
        hasExited: () => done,
        close: () => Result.tryPromise({
          try: async () => {
            if (!done) {
              child.kill("SIGTERM");
              const timer = setTimeout(() => { if (!done) child.kill("SIGKILL"); }, config.stopTimeoutMs);
              try { await exited; } finally { clearTimeout(timer); }
            }
            await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          },
          catch: () => new LoginBrowserError({ reason: "cleanup", message: "The login browser could not be closed or its RAM profile removed. New logins are blocked; restart the container to clear it." }),
        }),
      };
    },
    catch: () => new LoginBrowserError({ reason: "launch", message: "The Discord login browser could not start. Check that Chromium, the bundled extension and the Selkies desktop are installed and running, then try again." }),
  });
  if (launched.isErr() && profileDir !== undefined) {
    const directory = profileDir;
    const wiped = await Result.tryPromise({
      try: () => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      catch: () => new LoginBrowserError({ reason: "cleanup", message: "The failed login browser left a RAM profile. Restart the container before trying again." }),
    });
    if (wiped.isErr()) return wiped;
  }
  return launched;
};

export const BrowserProcess = {
  create,
  args,
  fromEnv: (env: Readonly<Record<string, string | undefined>> = process.env): BrowserLauncher => create({
    chromiumPath: env.DISCORD_MCP_CHROMIUM?.trim() || "/usr/bin/chromium",
    profileRoot: env.DISCORD_MCP_LOGIN_BROWSER_DIR?.trim() || "/dev/shm/discord-mcp-browser",
    extensionPath: env.DISCORD_MCP_LOGIN_EXTENSION?.trim() || "/app/login-extension",
    stopTimeoutMs: 5_000,
  }),
} as const;
