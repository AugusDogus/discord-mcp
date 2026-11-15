import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
import { Env } from "@/lib/env";
import { Agents } from "./_components/agents";

export const metadata: Metadata = { title: { absolute: "discord-mcp" } };

export default function DashboardPage() {
  return (
    <AppShell
      aside={
        <Suspense fallback={null}>
          <Identity />
        </Suspense>
      }
    >
      <Suspense fallback={<div aria-hidden className="h-32 animate-pulse rounded-xl bg-surface-muted" />}>
        <Home />
      </Suspense>
    </AppShell>
  );
}

/** Who is signed in (your tailnet identity, so there is no sign-out). */
async function Identity() {
  const user = await requireCurrentUser();
  return (
    <span className="truncate text-sm text-muted" title={user.email}>
      {user.name || user.email}
    </span>
  );
}

async function Home() {
  const user = await requireCurrentUser();
  return <Agents userId={user.id} mcpUrl={Env.mcpResourceUrl()} />;
}
