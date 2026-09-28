"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PlatformIcon } from "@/components/platform-icon";
import {
  clearPolicyAction,
  setPolicyAction,
  type ActionState,
} from "@/app/actions/runtime";
import type { PolicyDecision } from "@/lib/runtime/plan";

/**
 * Every account and every side-effecting tool, with the decision in force.
 *
 * ## Why the select is the only control
 *
 * A policy has exactly three values and no free text, so a `<select>` is not a
 * stylistic choice — it is a control that cannot express a value the backend
 * would refuse. Three radio buttons, or a free-text field with a validator, both
 * make it possible to *try* to write something invalid; a select cannot.
 *
 * ## Why a refusal is shown, not swallowed
 *
 * `setPolicy` refuses two things: an account the user does not own, and a tool
 * with no side effect. The second is the one that matters here — "ask first
 * before `compose_post`" is a sensible-sounding request that cannot be honoured,
 * because the text a compose step writes is what a *later* step publishes, and
 * the most the Runtime could do is approve a brief.
 *
 * Those tools are shown, disabled, with that reason. Hiding them would make the
 * list read as a complete set of things the user controls, and it is not one:
 * a user who cannot find `compose_post` has no way to learn that it is a
 * different kind of thing. A disabled row with a sentence is the answer.
 *
 * ## Why the row does not change on click
 *
 * The value shown is the one the server confirmed. `setPolicy` can refuse, and a
 * row that has already moved to "Never" while the server said "that account is
 * not yours" is a user acting on a policy that is not there. So the select is
 * held at the confirmed value until the action returns, and a refusal restores
 * it and shows the reason.
 */
const DECISIONS: ReadonlyArray<{
  value: PolicyDecision;
  label: string;
}> = [
  { value: "auto", label: "Automatic" },
  { value: "approval", label: "Ask first" },
  { value: "disabled", label: "Never" },
];

export function PolicyTable({
  accounts,
  tools,
}: {
  accounts: Array<{ accountKey: string; decision: PolicyDecision }>;
  tools: Array<{ name: string; decision: PolicyDecision }>;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Account</TableHead>
                <TableHead className="w-44">Decision</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => (
                <PolicyRow
                  key={`account:${account.accountKey}`}
                  scope="account"
                  scopeKey={account.accountKey}
                  decision={account.decision}
                  label={
                    <>
                      <PlatformIcon
                        platform={account.accountKey.split(":")[0] ?? ""}
                        size={18}
                      />
                      <span className="font-mono text-xs">
                        {account.accountKey}
                      </span>
                    </>
                  }
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tool</TableHead>
                <TableHead className="w-44">Decision</TableHead>
                <TableHead className="w-28" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tools.map((tool) => (
                <PolicyRow
                  key={`tool:${tool.name}`}
                  scope="tool"
                  scopeKey={tool.name}
                  decision={tool.decision}
                  label={<code className="text-xs">{tool.name}</code>}
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function PolicyRow({
  scope,
  scopeKey,
  decision,
  label,
}: {
  scope: "account" | "tool";
  scopeKey: string;
  decision: PolicyDecision;
  label: React.ReactNode;
}) {
  const router = useRouter();

  const [current, setCurrent] = React.useState(decision);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<ActionState | null>(null);

  async function change(next: PolicyDecision) {
    if (next === current) return;
    setBusy(true);
    setMessage(null);

    const formData = new FormData();
    formData.set("scope", scope);
    formData.set("scopeKey", scopeKey);
    formData.set("decision", next);

    const result =
      next === "auto"
        ? await clearPolicyAction(null, formData)
        : await setPolicyAction(null, formData);

    setBusy(false);
    setMessage(result);

    // Either way the stored value is now the authority, and this component's
    // copy of it has to match. A refusal puts it back where it was, which is
    // the whole point of not moving it optimistically.
    if (result.ok) {
      setCurrent(next);
      router.refresh();
    } else {
      setCurrent(decision);
    }
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2.5">{label}</div>
        {message ? (
          <p
            className={
              message.ok
                ? "mt-1 text-xs text-muted-foreground"
                : "mt-1 text-xs text-red-600 dark:text-red-400"
            }
          >
            {message.message}
          </p>
        ) : null}
      </TableCell>

      <TableCell>
        <select
          value={current}
          disabled={busy}
          aria-label={`Decision for ${scopeKey}`}
          onChange={(event) => void change(event.target.value as PolicyDecision)}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {DECISIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </TableCell>

      <TableCell>
        {busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
      </TableCell>
    </TableRow>
  );
}
