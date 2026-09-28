import Link from "next/link";
import { KeyRound, ShieldCheck, Sparkles } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PolicyTable } from "@/components/runtime/policy-table";
import { requireSessionUser } from "@/lib/session";
import {
  describePolicyTargets,
  policyDecisionsFor,
} from "@/lib/runtime/approval-store";

/**
 * `/settings/policies` — what the Runtime may do without asking.
 *
 * ## Why this is Settings and not the approvals screen
 *
 * The two are the same *subject* and different *moods*. An approval is a question
 * with a deadline; a policy is a standing answer to "should I be asked?". They
 * are separated so the inbox stays a list of things waiting, and so configuring
 * "never ask me again" is somewhere deliberate rather than two clicks from
 * approving this one post.
 *
 * Putting them together would also invite the confusion that matters most: a
 * user who changes a policy while a run is suspended for approval expects it to
 * apply to that run, and it does — `disabled` is checked before a recorded
 * approval is honoured — but only at the next step. On one screen, that would be
 * indistinguishable from the setting not having applied at all.
 *
 * ## Why the whole catalogue is listed, not just what is set
 *
 * Every account and every gateable tool is shown with its current decision,
 * including the ones set to `auto`. A table of only the user's exceptions cannot
 * be read: "what does the Runtime do with my X account?" is answered by the
 * absence of a row, which is not an answer. Showing `auto` explicitly means
 * every row is a decision the user can see and change.
 *
 * ## Why the tool list is exactly what the store says may be named
 *
 * `describePolicyTargets` returns `approvableToolNames()` — already filtered to
 * tools with a side effect. That filter is not repeated here, and a disabled row
 * for `compose_post` is deliberately *not* drawn instead.
 *
 * The tempting alternative is to list every tool with the ungateable ones greyed
 * out and explained. It was rejected because the store would refuse to write a
 * policy for them anyway, so the control would be a thing on the screen that
 * cannot be used. Offering a setting the backend silently discards is the exact
 * failure `setPolicy`'s refusals were written to prevent: the user believes a
 * gate is in place and it is not. The explanation of *why* those tools are not
 * listed belongs in prose below, not in a dead control.
 *
 * ## Why a refusal would be shown
 *
 * `setPolicy` refuses an account the user does not own. That refusal is surfaced
 * verbatim by the table rather than hidden, because it means the user named
 * something that looked valid and was not.
 */
export default async function PoliciesPage() {
  const user = await requireSessionUser();

  const [targets, set] = await Promise.all([
    describePolicyTargets(user.id),
    policyDecisionsFor(user.id),
  ]);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Execution policies</h1>
        <p className="text-sm text-muted-foreground">
          What the Runtime may do on its own. Anything not changed here runs
          automatically.
        </p>
      </header>

      <HowItWorks />

      <PolicyTable
        accounts={targets.accounts.map((accountKey) => ({
          accountKey,
          decision: set.get(`account:${accountKey}`) ?? "auto",
        }))}
        tools={targets.tools.map((name) => ({
          name,
          decision: set.get(`tool:${name}`) ?? "auto",
        }))}
      />

      <Card className="border-border/60">
        <CardContent className="space-y-1 py-4 text-sm text-muted-foreground">
          <p>
            Only tools that publish something are listed. A tool that writes text
            for a later step to publish has nothing to approve — the publish is
            what asks.
          </p>
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4 text-sm text-muted-foreground">
          <p>
            The client id and secret each platform is registered with are
            configured here too.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/credentials">
              <KeyRound className="size-4" />
              App credentials
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The three decisions, in the user's terms.
 *
 * Written out because "auto / approval / disabled" is a table of internal names
 * and the one that matters most — `disabled` — is the one whose name least
 * suggests what it does. It does not ask; it refuses. A goal naming a disabled
 * account or tool has its step *failed at dispatch* and the run continues, which
 * is deliberately different from the plan gate refusing the plan outright.
 */
function HowItWorks() {
  const rows = [
    {
      icon: Sparkles,
      name: "Automatic",
      what: "The Runtime does it without asking. This is the default for everything.",
    },
    {
      icon: ShieldCheck,
      name: "Ask first",
      what: "The run stops and the post waits for you on the Approvals screen. It publishes only if you say go ahead, and fails if nobody answers within 24 hours.",
    },
    {
      icon: KeyRound,
      name: "Never",
      what: "The step is refused at dispatch and the run carries on with the rest. Nothing is published to this target, and no question is asked.",
    },
  ];

  return (
    <Card>
      <CardContent className="grid gap-4 py-5 sm:grid-cols-3">
        {rows.map(({ icon: Icon, name, what }) => (
          <div key={name} className="space-y-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Icon className="size-4 text-muted-foreground" />
              {name}
            </p>
            <p className="text-xs text-muted-foreground">{what}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
