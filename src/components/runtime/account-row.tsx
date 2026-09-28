"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Power, Unplug } from "lucide-react";

import { cn } from "@/components/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlatformIcon } from "@/components/platform-icon";

/**
 * One connected account, with the two actions that apply to it.
 *
 * ## Switching off is not disconnecting
 *
 * These are separated because they answer different questions and only one of
 * them is reversible.
 *
 * **Switching off** is the answer to "I do not want this account used right
 * now". It is instant, it keeps the token, and switching it back on is one
 * click. It is also the control that matters for a *goal*: `validateGoal`
 * refuses a disabled account as a target, and `resolveAccount` will not hand it
 * to the Runtime — so switching one off makes the goals that name it fail
 * validation at save time rather than publishing to somewhere the user no
 * longer wants.
 *
 * **Disconnecting** removes the account and its grant. It is irreversible from
 * this screen and needs a fresh authorization to undo, because the grant is the
 * thing being deleted. So it is behind a confirmation that names the account.
 *
 * Putting them in one menu would make the reversible one look like the
 * irreversible one, and users reach for the scarier option when the gentler
 * one is not offered.
 *
 * ## Why the state follows the server
 *
 * `setAccountEnabled` and `disconnectAccount` both return whether they changed
 * a row, and both are scoped to `userId` in their `WHERE`. A row that is not
 * this user's is not updated, so the button reports what actually happened. The
 * switch is not flipped optimistically: a user watching a toggle animate to "on"
 * for an account that was never changed is worse than a brief wait.
 */
export function AccountRow({
  account,
  problem,
  canPublish,
  platformCapabilities,
}: {
  account: {
    id: string;
    accountKey: string;
    platform: string;
    handle: string | null;
    enabled: boolean;
    capabilities: string[];
  };
  problem: "expired" | "no_token" | null;
  canPublish: boolean;
  /** What the platform supports, for the case where the stored set is missing. */
  platformCapabilities: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<"toggle" | "disconnect" | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // A capability set read from the registry rather than the row means the stored
  // one was absent. Shown as the platform's set, because that is what
  // `resolveAccount` falls back to, and hiding the difference would show an
  // empty list for an account that can in fact publish.
  const fromRegistry = account.capabilities.length === 0;
  const capabilities = fromRegistry ? platformCapabilities : account.capabilities;

  async function run(what: "toggle" | "disconnect") {
    setBusy(what);
    setError(null);
    try {
      const { setAccountEnabledAction, disconnectAccountAction } = await import(
        "@/app/actions/accounts"
      );
      const result =
        what === "toggle"
          ? await setAccountEnabledAction(account.id, !account.enabled)
          : await disconnectAccountAction(account.id);
      if (!result.ok) setError(result.message);
      else router.refresh();
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  }

  return (
    <li className="px-6 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <PlatformIcon platform={account.platform} size={24} />
          <div className="min-w-0 space-y-1">
            <p className="truncate font-medium">
              {account.handle ?? account.accountKey}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {account.platform}
              </span>
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {account.accountKey}
            </p>

            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              {problem ? (
                <Badge variant="danger">
                  {problem === "expired" ? "Token expired" : "No token"}
                </Badge>
              ) : null}
              {!account.enabled ? <Badge variant="quiet">Switched off</Badge> : null}
              {canPublish ? (
                <Badge variant="success">Can publish</Badge>
              ) : (
                <Badge variant="warning">Cannot publish</Badge>
              )}
              {fromRegistry ? (
                <Badge variant="quiet" className="text-[10px]">
                  default capabilities
                </Badge>
              ) : null}
            </div>

            {capabilities.length > 0 ? (
              <details className="pt-1">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  {capabilities.length} capabilit
                  {capabilities.length === 1 ? "y" : "ies"}
                </summary>
                <p className="mt-1 flex flex-wrap gap-1">
                  {capabilities.map((capability) => (
                    <code
                      key={capability}
                      className="rounded bg-muted px-1.5 py-0.5 text-[10px]"
                    >
                      {capability}
                    </code>
                  ))}
                </p>
              </details>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {confirming ? (
            <>
              <span className="text-xs text-muted-foreground">
                Remove this account and its access?
              </span>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy !== null}
                onClick={() => void run("disconnect")}
              >
                {busy === "disconnect" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => void run("toggle")}
              >
                {busy === "toggle" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Power className="size-4" />
                )}
                {account.enabled ? "Switch off" : "Switch on"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                className="text-muted-foreground hover:text-red-500"
                onClick={() => setConfirming(true)}
              >
                <Unplug className="size-4" />
                <span className={cn("sr-only")}>
                  Disconnect {account.handle ?? account.accountKey}
                </span>
              </Button>
            </>
          )}
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </li>
  );
}
