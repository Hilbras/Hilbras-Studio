import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader } from "@/components/runtime/empty-state";
import { ExecutionBadge, StatusBadge } from "@/components/runtime/status-badge";
import { GoalControls } from "@/components/runtime/goal-controls";
import { requireSessionUser } from "@/lib/session";
import { goalHealth, getGoal, listRecentRuns } from "@/lib/goals/service";
import { listAccounts } from "@/lib/accounts/store";
import { listTimeZonesAction } from "@/app/actions/goals";
import { GoalForm, type GoalTargetView } from "@/components/runtime/goal-form";
import { describeCron, parseCron } from "@/lib/goals/cron";
import { goalStatus, relativeTime } from "@/lib/runtime/view";

/**
 * One goal: its configuration, its controls, and its history.
 *
 * ## Why the form is inline rather than behind an edit link
 *
 * There is no edit mode. A goal is a small object with five fields, and a
 * separate "Edit" screen adds a navigation step to the most common edit in the
 * product — changing a schedule or swapping an account. The controls that are
 * *not* fields (pause, resume, archive) are separate buttons below, because
 * those are decisions rather than edits and should not be a value typed into a
 * form and saved.
 *
 * ## Why the history is this goal's only
 *
 * The dashboard shows runs across every goal; this shows one goal's firings,
 * newest first. A user asking "did *this* post" wants a list they can read
 * rather than a filtered view of something else, and the filter is applied in
 * the query so the count is right rather than approximate.
 */
export default async function GoalPage({
  params,
}: {
  params: Promise<{ goalId: string }>;
}) {
  const { goalId } = await params;
  const user = await requireSessionUser();

  const goal = await getGoal(user.id, goalId);
  // `notFound` rather than a redirect or an empty page: a goal id that is not
  // this user's and one that does not exist are the same answer, which is also
  // what keeps the page from confirming that someone else's goal id is real.
  if (!goal) notFound();

  const [accounts, timeZones, runs, health] = await Promise.all([
    listAccounts(user.id),
    listTimeZonesAction(),
    listRecentRuns(goal.id, 20),
    goalHealth(goal.id),
  ]);

  const targets: GoalTargetView[] = accounts.map((account) => {
    const canPublish = account.capabilities.includes("publish_post");
    let reason: string | undefined;
    if (!account.enabled) reason = "Switched off. Turn it on in Accounts.";
    else if (!canPublish) reason = "This account type cannot publish posts.";
    return {
      accountKey: account.accountKey,
      platform: account.platform,
      handle: account.handle,
      enabled: account.enabled,
      selectable: account.enabled && canPublish,
      ...(reason ? { reason } : {}),
    };
  });

  const cron = parseCron(goal.scheduleCron);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/goals">
            <ArrowLeft className="size-4" />
            All goals
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              {goal.title}
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {goal.statement}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge meta={goalStatus(goal.status)} />
            <Badge variant={health === "succeeded" ? "success" : "quiet"}>
              {health === "succeeded" ? "Last run worked" : health.replace(/_/g, " ")}
            </Badge>
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <div className="flex gap-1.5">
            <dt className="font-medium text-foreground">Schedule</dt>
            <dd>
              {cron.ok ? describeCron(cron.fields) : goal.scheduleCron}
              {goal.scheduleTimezone !== "UTC" ? ` · ${goal.scheduleTimezone}` : ""}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-medium text-foreground">Next</dt>
            <dd>
              {goal.nextFiringAt ? relativeTime(goal.nextFiringAt) : "not scheduled"}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="font-medium text-foreground">Targets</dt>
            <dd>{goal.targetAccounts.join(", ") || "none"}</dd>
          </div>
        </dl>
      </header>

      <GoalControls goalId={goal.id} status={goal.status} />

      <section className="space-y-4">
        <SectionHeader
          title="Configuration"
          description="Saved changes take effect from the next firing."
        />
        <GoalForm
          mode="edit"
          goalId={goal.id}
          accounts={targets}
          timeZones={timeZones}
          defaults={{
            title: goal.title,
            statement: goal.statement,
            schedule: goal.scheduleCron,
            timeZone: goal.scheduleTimezone,
            targetAccounts: goal.targetAccounts,
          }}
        />
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Firings"
          description="Every run this goal has made, newest first."
          action={
            runs.length > 0 ? (
              <Button asChild variant="ghost" size="sm">
                <Link href="/runtime/runs">
                  <History className="size-4" />
                  All runs
                </Link>
              </Button>
            ) : null
          }
        />

        {runs.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              This goal has not fired yet.
              {goal.nextFiringAt
                ? ` Its first firing is ${relativeTime(goal.nextFiringAt)}.`
                : ""}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-border/50">
                {runs.map((run) => (
                  <li key={run.id}>
                    <Link
                      href={`/runs/${run.id}`}
                      className="flex items-center justify-between gap-4 px-6 py-3.5 transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate text-sm font-medium">
                          {run.scheduleSlot}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {relativeTime(run.createdAt)}
                          {run.attempt > 1 ? ` · attempt ${run.attempt}` : ""}
                        </p>
                      </div>
                      <ExecutionBadge state={run.state} />
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
