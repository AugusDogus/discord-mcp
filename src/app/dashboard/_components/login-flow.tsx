"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import QRCode from "qrcode";
import { Actions, Alert, buttonClass, PageTitle, Spinner } from "@/app/_components/ui";
import { LoginView } from "@/lib/login-browser/login-view";

function Qr({ url }: { url: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    void QRCode.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M" }).then((svg) => {
      if (!stopped) setImage(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    });
    return () => { stopped = true; };
  }, [url]);
  return image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="Scan this QR code in Discord" className="size-52 rounded-lg bg-white sm:size-60" />
  ) : <Spinner />;
}

const stop = () => fetch("/api/discord/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "stop" }),
  keepalive: true,
}).catch(() => undefined);

const readError = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => null);
  return typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
    ? body.error
    : `Discord login failed (HTTP ${response.status}). Try again.`;
};

/**
 * The browser login. `next` is a validated same-origin path to open once the
 * account is saved; `cancelHref`, when set, offers a way back.
 */
export function LoginFlow({ next, cancelHref }: { next: string; cancelHref: string | null }) {
  const router = useRouter();
  const [view, setView] = useState<LoginView>({ stage: "starting" });
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => () => { setView({ stage: "starting" }); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    let finished = false;
    let starting = true;
    const poll = async () => {
      if (polling || finished || controller.signal.aborted) return;
      polling = true;
      try {
        const response = await fetch("/api/discord/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(starting ? {
            action: "start",
            colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
          } : { action: "poll" }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        starting = false;
        if (!response.ok) {
          finished = true;
          setView({ stage: "error", message: await readError(response) });
          return;
        }
        const parsed = LoginView.Schema.safeParse(await response.json());
        if (controller.signal.aborted) return;
        if (!parsed.success) {
          finished = true;
          setView({ stage: "error", message: "The login response was unreadable. Try again." });
          return;
        }
        setView(parsed.data);
        finished = parsed.data.stage === "error" || parsed.data.stage === "loggedIn";
        if (parsed.data.stage === "loggedIn") {
          if (next === "/dashboard") {
            router.replace(next);
            router.refresh();
          } else window.location.replace(next);
        }
      } catch {
        if (!controller.signal.aborted) {
          finished = true;
          setView({ stage: "error", message: "Could not reach discord-mcp. Check your connection and try again." });
        }
      } finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 1_000);
    const close = () => { void stop(); };
    window.addEventListener("pagehide", close);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("pagehide", close);
      void stop();
    };
  }, [attempt, next, router]);

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={view.stage === "scanned" ? "Confirm on your phone" : view.stage === "browser" ? "Log in to Discord" : "Scan with Discord on your phone"}>
        {view.stage === "scanned" ? "Approve the login in Discord." : view.stage === "browser" ? (view.reason === "captcha" ? "Discord wants a captcha. Solve it below." : "Complete the login in the browser below, including any verification Discord asks for.") : "Settings > Scan QR Code"}
      </PageTitle>
      {view.stage === "error" ? (
        <>
          <Alert tone="danger">{view.message}</Alert>
          <Actions>
            {cancelHref === null ? null : <Link href={cancelHref} className={buttonClass("secondary")}>Cancel</Link>}
            <button type="button" className={buttonClass()} onClick={async () => {
              await stop();
              setView({ stage: "starting" });
              setAttempt((value) => value + 1);
            }}>Try again</button>
          </Actions>
        </>
      ) : (
        <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-muted">
          {view.stage === "browser" ? (
            <iframe src="/login-browser/" title="Discord login" allow="clipboard-read; clipboard-write" referrerPolicy="no-referrer" onLoad={(event) => event.currentTarget.focus()} className="absolute inset-0 size-full bg-black" />
          ) : view.stage === "qr" ? (
            <Qr key={view.url} url={view.url} />
          ) : view.stage === "scanned" ? (
            <div className="flex flex-col items-center gap-4" role="status">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={view.user.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-20 rounded-full" />
              <p className="text-sm font-medium">{view.user.name}</p>
              <span className="flex items-center gap-2 text-sm text-muted"><Spinner />Confirm on your phone</span>
            </div>
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted" role="status"><Spinner />{view.stage === "loggedIn" ? "Opening discord-mcp" : "Starting a browser"}</span>
          )}
        </div>
      )}
      {view.stage === "error" || cancelHref === null ? null : (
        <Actions>
          <Link href={cancelHref} className={buttonClass("secondary")}>Cancel</Link>
        </Actions>
      )}
    </div>
  );
}
