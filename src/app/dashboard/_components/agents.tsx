import { connection } from "next/server";
import { Alert, buttonClass, Section } from "@/app/_components/ui";
import { timeAgo } from "@/app/_lib/time";
import { getDb } from "@/lib/db/client";
import { OAuthGrants } from "@/lib/oauth/grants";
import { CopyButton } from "../client-actions";

/**
 * The MCP address to give an agent, and the agents already approved, each
 * revocable and showing the Discord account it acts as. Reads the database: render inside <Suspense>. Client names come
 * from dynamic registration and are untrusted; React escapes them.
 */
/** A stored Discord account an agent can use, as its row shows it. */
export type AgentAccount = { readonly id: string; readonly name: string; readonly avatarUrl: string };

export async function Agents({ userId, mcpUrl, accounts }: { userId: string; mcpUrl: string; accounts: readonly AgentAccount[] }) {
  await connection();
  const grants = await OAuthGrants.listActive(getDb(), userId);
  const now = new Date();

  return (
    <Section title="Agents">
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface py-1.5 pr-1.5 pl-4">
        <code className="min-w-0 flex-1 truncate font-mono text-[13px]" title={mcpUrl}>
          {mcpUrl}
        </code>
        <CopyButton value={mcpUrl} />
      </div>
      {grants.match({
        err: () => (
          <Alert tone="danger">Could not load your agents. They are unchanged; reload the page to try again.</Alert>
        ),
        ok: (list) =>
          list.length === 0 ? (
            <p className="text-sm leading-6 text-muted">
              Add this address to an MCP client as a remote server. It shows up here once you approve it.
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {list.map((grant) => (
                <li key={grant.id} className="flex items-center gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={grant.clientName}>
                      {grant.clientName}
                    </p>
                    <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
                      <AccountLabel account={accounts.find((account) => account.id === grant.discordAccountId) ?? null} />
                      <span aria-hidden>·</span>
                      <span className="shrink-0">
                        {grant.lastUsedAt ? `Used ${timeAgo(grant.lastUsedAt, now)}` : `Approved ${timeAgo(grant.createdAt, now)}`}
                      </span>
                    </p>
                  </div>
                  <form method="post" action={`/api/oauth/grants/${encodeURIComponent(grant.id)}/revoke`}>
                    <button type="submit" className={buttonClass("ghost")}>
                      Revoke
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          ),
      })}
    </Section>
  );
}

function AccountLabel({ account }: { account: AgentAccount | null }) {
  if (account === null) return <span className="truncate">No Discord account</span>;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={account.avatarUrl} alt="" className="size-4 shrink-0 rounded-full" />
      <span className="truncate">{account.name}</span>
    </>
  );
}
