import type { Metadata } from "next";
import { Suspense } from "react";
import { Alert, AppShell, Section } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
import { Env } from "@/lib/env";
import { DiscordRuntime } from "@/lib/discord/runtime";
import { AccountRow } from "./_components/account-row";
import { DiscordUser } from "@/lib/discord/user";
import { LoginFlow } from "./_components/login-flow";
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
  const account = await DiscordRuntime.health(user.id);
  if (account.isErr()) return <Alert tone="danger">{account.error.message}</Alert>;
  if (account.value.kind === "login") return <LoginFlow />;
  const { account: record, health, message } = account.value;
  return <>
    <Section title="Account">
      <AccountRow name={DiscordUser.displayName(record.user)} handle={DiscordUser.handle(record.user)} avatarUrl={DiscordUser.avatarUrl(record.user)} presenceOnWrite={record.presenceOnWrite} verified={health === "verified"} message={message} />
    </Section>
    <Suspense fallback={<div aria-hidden className="h-32 animate-pulse rounded-xl bg-surface-muted" />}>
      <Agents userId={user.id} mcpUrl={Env.mcpResourceUrl()} />
    </Suspense>
  </>;
}
