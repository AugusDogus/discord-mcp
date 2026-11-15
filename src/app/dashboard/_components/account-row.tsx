"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Actions, Alert, buttonClass, Spinner } from "@/app/_components/ui";

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const errorText = async (response: Response) => {
  try {
    const body: unknown = await response.json();
    const parsed = z.object({ error: z.string() }).safeParse(body);
    if (parsed.success) return parsed.data.error;
  } catch {
    /* Use the actionable fallback below. */
  }
  return "Could not save this change. Reload the dashboard and try again.";
};
export function AccountRow({
  name,
  handle,
  avatarUrl,
  presenceOnWrite,
  verified,
  message,
}: {
  name: string;
  handle: string;
  avatarUrl: string;
  presenceOnWrite: boolean;
  verified: boolean;
  message?: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [enabled, setEnabled] = useState(presenceOnWrite);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (document.hidden || polling) return;
      polling = true;
      try {
        const response = await fetch("/api/discord/account", { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const body: unknown = await response.json();
          const parsed = z
            .object({ kind: z.enum(["connected", "login"]), health: z.enum(["verified", "unknown"]).optional() })
            .safeParse(body);
          if (parsed.success && (parsed.data.kind === "login" || (parsed.data.health === "verified") !== verified))
            router.refresh();
        } else if (response.status === 401) router.refresh();
      } catch {
        /* A temporary outage retries at the next visible poll. */
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 30_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [router, verified]);

  async function save(action: "presence" | "logout", value = enabled) {
    setPending(true);
    setError(null);
    try {
      const response = await post(`/api/discord/${action}`, action === "presence" ? { enabled: value } : {});
      if (!response.ok) setError(await errorText(response));
      else {
        if (action === "presence") setEnabled(value);
        setConfirming(false);
        router.refresh();
      }
    } catch {
      setError("Could not reach discord-mcp. Check your connection, then retry.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={avatarUrl} alt="" className="size-10 rounded-full" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="flex items-center gap-2 text-sm text-muted">
              <span aria-hidden className={`size-2 shrink-0 rounded-full ${verified ? "bg-success" : "bg-warning"}`} />
              {handle}
              <span className="sr-only">{verified ? "Login verified" : "Login check unavailable"}</span>
            </p>
          </div>
        </div>
        {confirming ? null : (
          <Actions>
            <button
              type="button"
              disabled={pending}
              className={buttonClass("ghost")}
              onClick={() => setConfirming(true)}
            >
              Log out
            </button>
          </Actions>
        )}
      </div>
      {confirming ? (
        <div className="flex flex-col gap-3 border-t border-border p-4">
          <p className="text-sm leading-6 text-muted">
            Log out of this Discord session, delete the stored login and key, and disconnect every agent. You can scan
            again later.
          </p>
          <Actions>
            <button
              type="button"
              disabled={pending}
              className={buttonClass("secondary")}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              className={buttonClass("danger")}
              onClick={() => {
                void save("logout");
              }}
            >
              {pending ? <Spinner /> : null}Log out
            </button>
          </Actions>
        </div>
      ) : (
        <label className="flex items-center justify-between gap-4 border-t border-border p-4 text-sm text-muted">
          Show me online when an agent sends or reacts
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={pending}
            onChange={(event) => {
              void save("presence", event.target.checked);
            }}
            className="size-4 shrink-0 accent-accent"
          />
        </label>
      )}
      {error || message ? (
        <div className="border-t border-border p-4">
          <Alert tone={error ? "danger" : "warning"}>{error ?? message}</Alert>
        </div>
      ) : null}
    </div>
  );
}
