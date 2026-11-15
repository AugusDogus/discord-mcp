"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Actions, Alert, buttonClass, PageTitle, Spinner } from "@/app/_components/ui";
import { LoginViewSchema, type LoginView } from "@/lib/discord/login-view";

function Qr({ url }: { url: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    void QRCode.toString(url, { type: "svg", margin: 2, errorCorrectionLevel: "M" }).then((svg) => {
      if (!stopped) setImage(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    });
    return () => {
      stopped = true;
    };
  }, [url]);
  // A data SVG keeps the QR crisp at every pixel density.
  return image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="Scan this QR code in Discord" className="size-52 rounded-lg bg-white sm:size-60" />
  ) : (
    <Spinner />
  );
}

export function LoginFlow() {
  const router = useRouter();
  const [view, setView] = useState<LoginView>({ stage: "starting" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    let finished = false;
    let restart = attempt > 0;
    const poll = async () => {
      if (document.hidden || polling || finished) return;
      polling = true;
      try {
        const response = await fetch("/api/discord/login", {
          method: restart ? "POST" : "GET",
          cache: "no-store",
          signal: controller.signal,
        });
        restart = false;
        if (!response.ok) {
          finished = true;
          setView({
            stage: "error",
            message:
              response.status === 401
                ? "Your sign-in expired. Reload this page to sign in again."
                : "Could not start Discord login. Try again in a moment.",
          });
          return;
        }
        const parsed = LoginViewSchema.safeParse(await response.json());
        if (!parsed.success) {
          finished = true;
          setView({ stage: "error", message: "The login response was unreadable. Try again." });
          return;
        }
        if (controller.signal.aborted) return;
        setView(parsed.data);
        finished = parsed.data.stage === "error" || parsed.data.stage === "loggedIn";
        if (parsed.data.stage === "loggedIn") {
          router.replace("/dashboard");
          router.refresh();
        }
      } catch {
        // A temporary network failure retries on the next visible poll.
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [attempt, router]);

  return (
    <div className="flex flex-col gap-6">
      <PageTitle title={view.stage === "scanned" ? "Confirm on your phone" : "Scan with Discord on your phone"}>
        {view.stage === "scanned" ? "Approve the login in Discord." : "Settings > Scan QR Code"}
      </PageTitle>
      {view.stage === "error" ? (
        <>
          <Alert tone="danger">{view.message}</Alert>
          <Actions>
            <button
              type="button"
              className={buttonClass()}
              onClick={() => {
                setView({ stage: "starting" });
                setAttempt((value) => value + 1);
              }}
            >
              Try again
            </button>
          </Actions>
        </>
      ) : (
        <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-muted">
          {view.stage === "qr" ? (
            <Qr key={view.url} url={view.url} />
          ) : view.stage === "scanned" ? (
            <div className="flex flex-col items-center gap-4" role="status">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={view.user.avatarUrl} alt="" className="size-20 rounded-full" />
              <p className="text-sm font-medium">{view.user.name}</p>
              <span className="flex items-center gap-2 text-sm text-muted">
                <Spinner />
                Confirm on your phone
              </span>
            </div>
          ) : (
            <span className="flex items-center gap-2 text-sm text-muted" role="status">
              <Spinner />
              {view.stage === "loggedIn" ? "Opening discord-mcp" : "Contacting Discord"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
