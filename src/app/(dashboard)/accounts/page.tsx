import Link from "next/link";
import { AlertTriangle, Link2, Plus, Unplug } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeader } from "@/components/runtime/empty-state";
import { AccountRow } from "@/components/runtime/account-row";
import { requireSessionUser } from "@/lib/session";
import { listAccounts, listAccountsNeedingAttention } from "@/lib/accounts/store";
import { capabilitiesForPlatform } from "@/lib/platforms";

/**
 * Connected accounts.
 *
 * ## What this page is, and what it used to be
 *
 * Before Phase 7, `/accounts` was a form for **app credentials** — the OAuth
 * client id and secret an app is registered with at a platform. That is a
 * *platform* setting, one per platform, and it is the same shape as every other
 * credential in Settings. It now lives at `/settings/credentials`, next to the
 * rest of them.
 *
 * This page is the other thing the word "account" means here: the `accounts`
 * table — a specific `platform:handle` the Runtime publishes to, its
 * capabilities, whether it is switched on, and whether its token still works.
 * That is per-user and per-account, and it is the thing a goal targets.
 *
 * The two were on one page because they are both called "accounts" and because
 * the Connect button lived next to the credential it needed. Splitting them is
 * the fix for a real confusion: a user with three connected handles and one set
 * of app credentials was looking at a page that showed them as the same kind of
 * thing, and the platform-level card said "Connected" while an individual account
 * two rows down had an expired token.
 *
 * ## Why capabilities are shown
 *
 * A goal's gate refuses any account that cannot `publish_post`, and
 * `validateGoal` refuses the goal at save time. That refusal is a sentence in a
 * form the user has already left. Showing the capability set here — and saying
 * plainly when an account cannot publish — is what turns "my goal was refused"
 * into "I see why".
 *
 * The set comes from `capabilitiesForAccount` where one is stored and from the
 * platform registry where one is not, which is the same function
 * `resolveAccount` uses at execution time. A capability list rendered from any
 * other source would be a list that could disagree with what the Runtime will
 * actually try.
 */
export default async function AccountsPage() {
  const user = await requireSessionUser();

  const [accounts, attention] = await Promise.all([
    listAccounts(user.id),
    listAccountsNeedingAttention(user.id),
  ]);

  // `listAccountsNeedingAttention` returns a reason per account rather than a
  // set, so the same account can in principle be listed twice. Reduced to a
  // lookup here because the row asks one question: is this account working?
  const problems = new Map(attention.map((row) => [row.accountKey, row.reason]));

  const publishable = accounts.filter((account) =>
    account.capabilities.includes("publish_post"),
  );

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Accounts</h1>
          <p className="text-sm text-muted-foreground">
            {accounts.length === 0
              ? "Nothing connected yet."
              : `${publishable.length} of ${accounts.length} can publish.`}
          </p>
        </div>
        <Button asChild variant="gold">
          <Link href="/settings/credentials">
            <Plus className="size-4" />
            Connect one
          </Link>
        </Button>
      </header>

      {problems.size > 0 ? (
        <Card className="border-amber-500/40 bg-amber-500/[0.04]">
          <CardContent className="flex items-start gap-3 py-4">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
            <div className="space-y-1">
              <p className="font-medium">
                {problems.size === 1
                  ? "1 account needs reconnecting"
                  : `${problems.size} accounts need reconnecting`}
              </p>
              <p className="text-sm text-muted-foreground">
                Goals targeting them will fail when they fire. Reconnecting
                replaces the token; nothing else about the account changes.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {accounts.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="No accounts connected"
          description="Connect a platform and the accounts on it appear here. Goals publish to the accounts you pick."
          action={
            <Button asChild variant="gold" size="sm">
              <Link href="/settings/credentials">Connect an account</Link>
            </Button>
          }
        />
      ) : (
        <section className="space-y-4">
          <SectionHeader
            title="Connected"
            description="Each row is one account a goal can publish to."
          />
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-border/50">
                {accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={{
                      id: account.id,
                      accountKey: account.accountKey,
                      platform: account.platform,
                      handle: account.handle,
                      enabled: account.enabled,
                      capabilities: [...account.capabilities],
                    }}
                    problem={problems.get(account.accountKey) ?? null}
                    canPublish={account.capabilities.includes("publish_post")}
                    platformCapabilities={[
                      ...capabilitiesForPlatform(account.platform),
                    ]}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      )}

      <Card className="border-border/60">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4 text-sm text-muted-foreground">
          <p>
            App credentials — the client id and secret each platform is registered
            with — live in Settings.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/credentials">
              <Unplug className="size-4" />
              Open credentials
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
