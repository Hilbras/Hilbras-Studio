import Link from "next/link";
import { Plus, Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeader } from "@/components/runtime/empty-state";
import { StatusBadge } from "@/components/runtime/status-badge";
import { requireSessionUser } from "@/lib/session";
import { goalHealth, listGoals } from "@/lib/goals/service";
import { goalStatus, relativeTime } from "@/lib/runtime/view";
import { describeCron, parseCron } from "@/lib/goals/cron";

/**
 * The goals dashboard.
 *
 * ## What a goal list is actually for
 *
 * Three questions, in the order they get asked: is it running, when does it
 * next run, and is it working. A list of titles answers none of them. So each
 * row carries the goal's status, its next firing, and — the part most goal
 * screens leave out — whether its **last run succeeded**.
 *
 * That last one is derived per goal by `goalHealth` rather than stored on the
 * goal, and the reason matters: a run finishes without the goal being touched,
 * so a denormalised copy would be stale exactly when it mattered. Reading it
 * here, per row, is the honest cost of not lying about health.
 *
 * ## "Never run" is not a failure
 *
 * A goal created a minute ago has never run, and that is the expected state, not
 * a problem. It is given its own neutral label rather than being folded into
 * either the healthy or the broken column, because a brand-new goal shown in red
 * teaches a user that the dashboard is alarming rather than informative.
 */
export default async function GoalsPage() {
  const user = await requireSessionUser();
  const goals = await listGoals(user.id);

  // Health is one query per goal and there is no batch form of it. Bounded by
  // how many goals a user has created, which is a form, not a workload — and
  // the alternative, a single window function over every user's most recent run,
  // is a much more expensive query that returns the same eight rows per goal.
  const rows = await Promise.all(
    goals.map(async (goal) => ({
      goal,
      health: await goalHealth(goal.id),
    })),
  );

  const active = rows.filter((row) => row.goal.status === "active");
  const inactive = rows.filter((row) => row.goal.status !== "active");

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Goals</h1>
          <p className="text-sm text-muted-foreground">
            {goals.length === 0
              ? "Nothing scheduled yet."
              : `${active.length} active, ${goals.length - active.length} not running.`}
          </p>
        </div>
        <Button asChild variant="gold">
          <Link href="/goals/new">
            <Plus className="size-4" />
            New goal
          </Link>
        </Button>
      </header>

      {goals.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No goals yet"
          description="A goal is a thing you want published on a schedule, described in your own words. The planner works out the steps each time it fires."
          action={
            <Button asChild variant="gold" size="sm">
              <Link href="/goals/new">Create your first goal</Link>
            </Button>
          }
        />
      ) : (
        <>
          {active.length > 0 ? (
            <section className="space-y-4">
              <SectionHeader title="Active" />
              <GoalList rows={rows.filter((row) => row.goal.status === "active")} />
            </section>
          ) : null}

          {inactive.length > 0 ? (
            <section className="space-y-4">
              <SectionHeader
                title="Not running"
                description="Paused and archived goals keep their history."
              />
              <GoalList rows={inactive} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function GoalList({
  rows,
}: {
  rows: Array<{
    goal: NonNullable<Awaited<ReturnType<typeof listGoals>>[number]>;
    health: Awaited<ReturnType<typeof goalHealth>>;
  }>;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y divide-border/50">
          {rows.map(({ goal, health }) => {
            const cron = parseCron(goal.scheduleCron);
            return (
              <li key={goal.id}>
                <Link
                  href={`/goals/${goal.id}`}
                  className="block px-6 py-4 transition-colors hover:bg-muted/40"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="truncate font-medium">{goal.title}</p>
                      <p className="line-clamp-1 text-sm text-muted-foreground">
                        {goal.statement}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusBadge meta={goalStatus(goal.status)} />
                      <HealthBadge health={health} />
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {cron.ok ? describeCron(cron.fields) : goal.scheduleCron}
                      {goal.scheduleTimezone !== "UTC"
                        ? ` (${goal.scheduleTimezone})`
                        : ""}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {goal.targetAccounts.length}{" "}
                      {goal.targetAccounts.length === 1 ? "account" : "accounts"}
                    </span>
                    <span aria-hidden>·</span>
                    <span>
                      {goal.nextFiringAt
                        ? `next ${relativeTime(goal.nextFiringAt)}`
                        : "not scheduled"}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * Whether the last run worked.
 *
 * `needs_attention` covers two states that a user can do something about and
 * the rest do not: a run that failed, and a run waiting on their approval.
 * Collapsing them into "failed" would tell a user to go and look for a broken
 * post when the actual thing waiting for them is a post to approve — and the
 * approval screen is elsewhere, so the pointer to it matters.
 */
function HealthBadge({ health }: { health: string }) {
  switch (health) {
    case "succeeded":
      return <Badge variant="success">Last run worked</Badge>;
    case "failed":
      return <Badge variant="danger">Last run failed</Badge>;
    case "needs_attention":
      return <Badge variant="warning">Needs attention</Badge>;
    case "running":
      return <Badge variant="progress">Running now</Badge>;
    case "never_run":
      return <Badge variant="quiet">Not run yet</Badge>;
    default:
      return <Badge variant="quiet">Unknown</Badge>;
  }
}
