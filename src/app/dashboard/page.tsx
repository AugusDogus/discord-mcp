import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Alert, AppShell, buttonClass, Section } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
import { Env } from "@/lib/env";
import { DiscordRuntime, type DashboardAccount } from "@/lib/discord/runtime";
import { CallbackUrl } from "@/app/sign-in/callback-url";
import { AccountRow, type AccountRowView } from "./_components/account-row";
import { DiscordUser } from "@/lib/discord/user";
import { LoginFlow } from "./_components/login-flow";
import { Agents, type AgentAccount } from "./_components/agents";

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
  const accounts = await DiscordRuntime.accounts(user.id);
  if (accounts.isErr()) return <Alert tone="danger">{accounts.error.message}</Alert>;
  if (accounts.value.length === 0) return <LoginFlow next={CallbackUrl.DEFAULT} cancelHref={null} />;
  const rows = accounts.value.map(rowOf);
  const summaries: AgentAccount[] = rows.flatMap((row) => (row.kind === "unreadable" ? [] : [{ id: row.id, name: row.name, avatarUrl: row.avatarUrl }]));
  return <>
    <Section title="Accounts" aside={<Link href="/dashboard/login" className={buttonClass("secondary")}>Add account</Link>}>
      <div className="flex flex-col gap-3">
        {rows.map((row) => <AccountRow key={row.id} account={row} />)}
      </div>
    </Section>
    <Suspense fallback={<div aria-hidden className="h-32 animate-pulse rounded-xl bg-surface-muted" />}>
      <Agents userId={user.id} mcpUrl={Env.mcpResourceUrl()} accounts={summaries} />
    </Suspense>
  </>;
}

const rowOf = (account: DashboardAccount): AccountRowView => {
  if (account.kind === "unreadable") return { kind: "unreadable", id: account.id, message: account.message };
  const { health } = account;
  const record = health.account;
  if (record === null) return { kind: "unreadable", id: account.id, message: "This stored Discord login can no longer be opened. Log it out, then add the account again." };
  const profile = { id: record.id, name: DiscordUser.displayName(record.user), handle: DiscordUser.handle(record.user), avatarUrl: DiscordUser.avatarUrl(record.user) };
  return health.kind === "login"
    ? { kind: "rejected", ...profile }
    : { kind: "connected", ...profile, presenceOnWrite: record.presenceOnWrite, verified: health.health === "verified", message: health.message ?? null };
};
