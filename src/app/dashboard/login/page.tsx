import type { Metadata } from "next";
import { Suspense } from "react";
import { AppShell } from "@/app/_components/ui";
import { requireCurrentUser } from "@/app/_lib/session";
import { CallbackUrl } from "@/app/sign-in/callback-url";
import { LoginFlow } from "../_components/login-flow";

export const metadata: Metadata = { title: { absolute: "Add a Discord account" } };

/** Logs in another Discord account (or the first one, for an agent's approval page), then goes to `next`. */
export default function AddAccountPage({ searchParams }: PageProps<"/dashboard/login">) {
  return (
    <AppShell>
      <Suspense fallback={<div aria-hidden className="h-32 animate-pulse rounded-xl bg-surface-muted" />}>
        <AddAccount searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}

async function AddAccount({ searchParams }: { searchParams: PageProps<"/dashboard/login">["searchParams"] }) {
  await requireCurrentUser();
  const { next } = await searchParams;
  return <LoginFlow next={CallbackUrl.parse(next)} cancelHref={CallbackUrl.DEFAULT} />;
}
