/**
 * Records the README demo video (`bun run demo:record`): logging in to
 * Discord with a QR in the real discord-mcp UI, the dashboard, and an agent's
 * approval. Ported from openrcs's scripts/demo/record.ts.
 *
 * What is real and what is faked:
 * - The app is the real production build (`next build`, `next start`) on a
 *   throwaway SQLite database with throwaway secrets, signed in through the
 *   real Tailscale-identity sign-in (the headers Tailscale Serve would add).
 * - The login browser is faked with a Playwright route on /api/discord/login:
 *   a made-up discord.com/ra QR, then the scanned profile, then logged in.
 *   At that point ./seed.ts saves the account (with a random token) through
 *   the app's own modules, so the dashboard after it is server-rendered.
 * - The avatar is github.com/AugusDogus.png, served where Discord's CDN
 *   would be. The browser reaches no other Discord host, and
 *   ./server-preload.mjs keeps the server from contacting Discord at all.
 * - The agent ("Claude Code") registers, is approved on the real consent
 *   page and gets its grant through the real OAuth endpoints; its loopback
 *   callback sends the browser back to the dashboard.
 *
 * Needs ffmpeg and Playwright's Chromium (`bunx playwright-core install chromium`).
 * Writes .demo/discord-mcp.mp4 (not committed). To publish it, attach it to a
 * PR comment (`gh issue comment <pr> --attach .demo/discord-mcp.mp4`) and put
 * the comment's github.com/user-attachments URL on its own line in the README.
 * DEMO_SKIP_BUILD=1 reuses the existing `.next` build.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";
import { z } from "zod";
import { DiscordUser } from "@/lib/discord/user";
import { LoginView } from "@/lib/login-browser/login-view";
import { installCursor, Pointer, type Point } from "./cursor";
import { run, startScreencast, writeFrameSequence } from "./screencast";
import { Seed } from "./seed";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT_DIR = join(ROOT, ".demo");

/** 1280x800 video of a 1120x700 window. */
const VIEWPORT = { width: 1120, height: 700 };
const SCALE = 8 / 7;
const VIDEO = { width: 1280, height: 800 };

// Demo identities: an example tailnet address, and the owner as the signed-in user.
const ORIGIN = "https://tower.example-tailnet.ts.net:6443";
const IDENTITY = { login: "augusdogus@github", name: "Augie" };
/** The Discord account the fake phone logs in: made up, apart from the public GitHub avatar. */
const DISCORD_USER: DiscordUser = {
  id: "1093847561029384756",
  username: "augusdogus",
  globalName: "augie",
  discriminator: "0",
  avatar: randomBytes(16).toString("hex"),
};
const AVATAR_SOURCE = "https://github.com/AugusDogus.png?size=256";
const AGENT = { name: "Claude Code", redirectUri: "http://localhost:47283/callback" };
/** Hosts the browser must never reach (the avatar route answers for cdn.discordapp.com). */
const DISCORD_HOSTS = /^[a-z]+:\/\/([^/?#]*\.)?(discord\.com|discord\.gg|discordapp\.com|discordapp\.net|discord\.media)(:\d+)?([/?#]|$)/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const portOf = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("demo: a loopback server has no TCP port");
  return address.port;
};

const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = portOf(server);
      server.close(() => resolvePort(port));
    });
  });

const waitForServer = async (url: string, server: ChildProcess) => {
  for (let i = 0; i < 100; i += 1) {
    if (server.exitCode !== null) throw new Error(`next start exited with ${server.exitCode}`);
    const ok = await fetch(url).then((r) => r.status < 500, () => false);
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`the app did not answer at ${url}`);
};

const centerOf = async (page: Page, selector: Parameters<Page["locator"]>[0]): Promise<Point> => {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`demo: ${selector} is not on the page`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** The app shows failures as alerts in <main> (Next's route announcer is another, empty one); the recording must not contain any. */
const expectNoAlert = async (page: Page, moment: string) => {
  const alerts = await page.locator('main [role="alert"]').allInnerTexts();
  if (alerts.length > 0) throw new Error(`demo: an error is showing ${moment}: ${alerts.join(" | ")}`);
};

const imagesLoaded = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      [...document.images].map((image) =>
        image.complete ? undefined : new Promise<void>((r) => image.addEventListener("load", () => r(), { once: true })),
      ),
    ).then(() => [...document.images].filter((image) => image.naturalWidth === 0).map((image) => image.src)),
  );

const expectImages = async (page: Page, moment: string) => {
  const broken = await imagesLoaded(page);
  if (broken.length > 0) throw new Error(`demo: broken images ${moment}: ${broken.join(", ")}`);
};

/** A public client registering itself, as an MCP client does before opening the browser. */
const registerAgent = async (appUrl: string) => {
  const response = await fetch(`${appUrl}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: AGENT.name,
      redirect_uris: [AGENT.redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (response.status !== 201) throw new Error(`demo: client registration answered HTTP ${response.status}`);
  const { client_id: clientId } = z.object({ client_id: z.string() }).parse(await response.json());
  const verifier = randomBytes(32).toString("base64url");
  return `/oauth/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: AGENT.redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: "discord:read discord:write",
    state: randomBytes(12).toString("base64url"),
    resource: `${ORIGIN}/api/mcp`,
  }).toString()}`;
};

const main = async () => {
  const work = mkdtempSync(join(tmpdir(), "discord-mcp-demo-"));
  mkdirSync(OUT_DIR, { recursive: true });
  const appPort = await freePort();
  const appUrl = `http://localhost:${appPort}`;

  const avatarResponse = await fetch(AVATAR_SOURCE);
  if (!avatarResponse.ok) throw new Error(`demo: could not download ${AVATAR_SOURCE} (HTTP ${avatarResponse.status})`);
  const avatar = Buffer.from(await avatarResponse.arrayBuffer());
  const avatarType = avatarResponse.headers.get("content-type") ?? "image/png";

  // The login stages the fake browser reports, checked against the app's own schema.
  const views = {
    starting: LoginView.Schema.parse({ stage: "starting" }),
    qr: LoginView.Schema.parse({ stage: "qr", url: `https://discord.com/ra/${randomBytes(32).toString("base64url")}` }),
    scanned: LoginView.Schema.parse({
      stage: "scanned",
      user: { name: DiscordUser.displayName(DISCORD_USER), avatarUrl: DiscordUser.avatarUrl(DISCORD_USER) },
    }),
    loggedIn: LoginView.Schema.parse({ stage: "loggedIn" }),
  };

  // Throwaway everything; Bun loaded .env.local, if any, which these override.
  Object.assign(process.env, {
    DATABASE_URL: `file:${join(work, "demo.db")}`,
    BETTER_AUTH_URL: ORIGIN,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64"),
    KEY_PEPPER: randomBytes(32).toString("base64"),
    NEXT_TELEMETRY_DISABLED: "1",
  });
  run("bun", ["src/lib/db/migrate.ts"]);
  if (process.env.DEMO_SKIP_BUILD !== "1") run("bun", ["run", "build"]);

  // Node, not Bun: Discord's gateways cannot open on Node (src/lib/discord/bun-websocket.ts).
  const server = spawn(join(ROOT, "node_modules/.bin/next"), ["start", "-p", String(appPort), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${join(ROOT, "scripts/demo/server-preload.mjs")}`,
      DEMO_DISCORD_USER: JSON.stringify({
        id: DISCORD_USER.id,
        username: DISCORD_USER.username,
        global_name: DISCORD_USER.globalName,
        discriminator: DISCORD_USER.discriminator,
        avatar: DISCORD_USER.avatar,
      }),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const blocked: string[] = [];
  server.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    process.stderr.write(text);
    for (const line of text.split("\n")) if (line.includes("[demo] blocked")) blocked.push(line.trim());
  });
  const browser = await chromium.launch({ channel: "chromium", args: ["--force-color-profile=srgb"] });

  try {
    await waitForServer(`http://127.0.0.1:${appPort}/sign-in`, server);
    const context = await browser.newContext({
      baseURL: appUrl,
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      colorScheme: "dark",
      locale: "en-US",
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: appUrl });
    await context.addInitScript(installCursor);

    // Only the app gets the identity headers Tailscale Serve adds. The page is
    // served from localhost, so requests that carry an Origin get the one a
    // browser on the tailnet address would send. Chromium keeps an intercepted
    // request's Origin, so those go through Playwright's own client.
    await context.route(`${appUrl}/**`, async (route) => {
      const headers = { ...(await route.request().allHeaders()), "tailscale-user-login": IDENTITY.login, "tailscale-user-name": IDENTITY.name };
      if (!("origin" in headers)) return route.fallback({ headers });
      const response = await route.fetch({ headers: { ...headers, origin: ORIGIN }, maxRedirects: 0 });
      // The approval's redirect to the agent's loopback callback: the agent
      // would take the code; the browser returns to the dashboard. (Chromium
      // does not intercept the target of a fulfilled redirect.)
      if (response.headers().location?.startsWith(`${AGENT.redirectUri}?code=`))
        return route.fulfill({ status: 303, headers: { location: `${appUrl}/dashboard` } });
      return route.fulfill({ response });
    });
    await context.route(DISCORD_HOSTS, (route) => route.abort("blockedbyclient"));
    await context.route("https://cdn.discordapp.com/**", (route) => route.fulfill({ body: avatar, contentType: avatarType }));

    // A moment on "Signing in as ..." before the session is created.
    await context.route(`${appUrl}/api/auth/sign-in/tailscale`, async (route) => {
      await sleep(1200);
      await route.fallback();
    });

    // The login browser: whatever stage the script has reached.
    let view: LoginView = views.starting;
    const Action = z.object({ action: z.enum(["start", "poll", "stop"]) });
    await context.route(`${appUrl}/api/discord/login`, async (route) => {
      const action = Action.safeParse(route.request().postDataJSON());
      if (action.success && action.data.action === "stop") await route.fulfill({ status: 204 }).catch(() => {});
      else await route.fulfill({ json: view, headers: { "cache-control": "no-store" } }).catch(() => {});
    });

    const page = await context.newPage();
    await page.setContent('<body style="margin:0;background:#121311">');
    const pointer = new Pointer(page, { x: 930, y: 560 });
    const capture = await startScreencast(page, VIDEO);
    await sleep(200);
    const tStart = Date.now() / 1000;

    // 1. Sign in with the Tailscale identity; land on the Discord login.
    await page.goto("/dashboard", { waitUntil: "commit" });
    await page.getByText(`Signing in as ${IDENTITY.login}`).waitFor();
    await pointer.jump(pointer.at);
    await page.getByRole("heading", { name: "Scan with Discord on your phone" }).waitFor();
    await page.waitForURL("**/dashboard");
    await pointer.jump(pointer.at);
    const userId = await Seed.userId(IDENTITY.login);
    await sleep(1300);

    // 2. The QR appears; the phone scans it.
    view = views.qr;
    const qr = page.getByAltText("Scan this QR code in Discord, or tap it on the phone with Discord");
    await qr.waitFor();
    await sleep(900);
    const qrBox = await qr.boundingBox();
    if (qrBox === null) throw new Error("demo: the QR code is not visible");
    await pointer.move({ x: qrBox.x + qrBox.width * 0.7, y: qrBox.y + qrBox.height * 0.62 }, 1100);
    await sleep(1800);
    await pointer.move({ x: qrBox.x + qrBox.width + 190, y: qrBox.y + qrBox.height * 0.8 }, 900);
    await sleep(900);

    // 3. Scanned: the phone's account, waiting for approval on the phone.
    view = views.scanned;
    await page.getByRole("heading", { name: "Confirm on your phone" }).waitFor();
    await expectImages(page, "on the scanned card");
    await sleep(3200);

    // 4. Approved on the phone: the login is saved and the dashboard opens.
    await Seed.logIn(userId, DISCORD_USER);
    view = views.loggedIn;
    await page.getByRole("heading", { name: "Accounts" }).waitFor();
    await expectImages(page, "on the dashboard");
    await expectNoAlert(page, "on the dashboard");
    await sleep(2200);

    // 5. Presence on writes: on.
    const presence = page.getByRole("switch");
    await pointer.move(await centerOf(page, '[role="switch"]'), 1100);
    await sleep(200);
    const saved = page.waitForResponse((response) => response.url().endsWith("/api/discord/presence"));
    await pointer.click();
    const presenceResponse = await saved;
    if (!presenceResponse.ok()) throw new Error(`demo: saving the presence setting answered HTTP ${presenceResponse.status()}`);
    if (!(await presence.isChecked())) throw new Error("demo: the presence switch did not turn on");
    await sleep(1400);
    await expectNoAlert(page, "after the presence switch");

    // 6. Copy the MCP address.
    await pointer.move(await centerOf(page, 'button:has-text("Copy")'), 1000);
    await sleep(150);
    await pointer.click();
    await page.getByRole("button", { name: "Copied" }).waitFor();
    await sleep(1300);

    // 7. The agent registers and opens its approval page.
    const authorize = await registerAgent(appUrl);
    // Beside the approval card that is about to open.
    await pointer.move({ x: VIEWPORT.width * 0.8, y: VIEWPORT.height * 0.62 }, 700);
    await page.goto(authorize);
    await page.getByRole("heading", { name: `Allow ${AGENT.name} to use discord-mcp?` }).waitFor();
    await pointer.jump(pointer.at);
    await expectNoAlert(page, "on the approval page");
    await sleep(2400);
    await pointer.move(await centerOf(page, 'button:has-text("Approve")'), 1100);
    await sleep(250);
    await pointer.click();

    // 8. Back on the dashboard, the agent is listed with its account.
    await page.waitForURL("**/dashboard");
    await page.getByText(AGENT.name).waitFor();
    await pointer.jump(pointer.at);
    await expectImages(page, "with the agent listed");
    await expectNoAlert(page, "with the agent listed");
    await sleep(500);
    await pointer.move({ x: pointer.at.x + 90, y: pointer.at.y + 110 }, 900);
    await sleep(2600);
    const tEnd = Date.now() / 1000;
    const frames = await capture.stop();
    if (blocked.length > 0) throw new Error(`demo: the server tried to reach Discord:\n${blocked.join("\n")}`);

    // Encode: H.264 MP4.
    const framesDir = mkdtempSync(join(work, "frames-"));
    const input = writeFrameSequence(frames, framesDir, tStart, tEnd);
    const mp4 = join(OUT_DIR, "discord-mcp.mp4");
    run("ffmpeg", [
      ...["-v", "error", "-y", ...input],
      ...["-vf", `scale=${VIDEO.width}:${VIDEO.height}:flags=lanczos:out_range=tv,format=yuv420p`, "-color_range", "tv"],
      ...["-c:v", "libx264", "-preset", "veryslow", "-crf", "20", "-tune", "animation", "-profile:v", "high"],
      ...["-movflags", "+faststart", "-an", mp4],
    ]);
    console.log(`${mp4}: ${(statSync(mp4).size / 1024).toFixed(0)} KiB, ${(tEnd - tStart).toFixed(1)} s`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    rmSync(work, { recursive: true, force: true });
  }
};

await main();
