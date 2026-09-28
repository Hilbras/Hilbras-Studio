import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Clock,
  History,
  ShieldAlert,
  Target,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, SectionHeader } from "@/components/runtime/empty-state";
import { StatusBadge } from "@/components/runtime/status-badge";
import { requireSessionUser } from "@/lib/session";
import { getRuntimeOverview, type RuntimeOverview } from "@/lib/runtime/queries";
import { executionStatus, relativeTime } from "@/lib/runtime/view";

/**
 * The Runtime dashboard.
 *
 * ## What this screen is for
 *
 * It answers one question above all: **is anything waiting for me?** Everything
 * else on it follows from that. Which is why the pending-approval count is the
 * first thing drawn, why it is the only number that is a link, and why it is
 * not summed into an "attention needed" total with anything else — a user who
 * sees one red number has to open the page to find out what it is.
 *
 * The alternative, a grid of equal-weight statistics, makes a user compare
 * numbers to work out which is asking something of them. A dashboard presenting
 * "3 runs completed" with the same weight as "1 post needs your approval" has
 * sorted its information by what is easy to count.
 *
 * ## Why the blocked-goal warning is not a statistic
 *
 * A goal can be active, in the schedule, and incapable of publishing: its
 * account was disconnected or switched off after the goal was saved. Nothing on
 * the goal row says so, and no run is created, so the only symptom is silence.
 *
 * This is the one class of Runtime problem that is *invisible from the run
 * history* — there is no failed run, because no run happened. So it gets a
 * warning card, not a count. A count would be read once, dismissed, and never
 * found again; a card saying "3 goals will not fire" with a link to the fix is
 * something a user returns to.
 *
 * ## Reading is server-side
 *
 * A page renders its own data with a direct call to the read module rather than
 * through a server action. Actions are the client-facing boundary (ADR-004);
 * a server component has no boundary to cross, and routing its own read
 * through an action would pay a serialisation round trip for data it is about
 * to render anyway.
 */
export default async function RuntimePage() {
  const user = await requireSessionUser();
  const overview = await getRuntimeOverview(user.id);

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Runtime</h1>
        <p className="text-sm text-muted-foreground">
          Your goals, what they are doing, and what is waiting on you.
        </p>
      </header>

      <WaitingOnYou overview={overview} />
      <BlockedGoals overview={overview} />
      <Counts overview={overview} />
      <RecentRuns overview={overview} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The one thing that is asking
// ---------------------------------------------------------------------------

/**
 * The approval banner, or nothing.
 *
 * Rendered as a banner rather than a card in the grid because it is the only
 * element on the screen with a deadline. A card among equals is scanned; a
 * banner is read. And the whole component returns `null` when there is nothing
 * waiting — a dashboard that always shows an empty "0 approvals" tile teaches a
 * user that the tile is not worth reading, which is the exact moment the real
 * one appears.
 *
 * The overdue count is shown separately from the pending count because they
 * mean different things. "2 waiting" is a task. "1 of those has already run out
 * of time" is a thing that is about to fail on its own, and a user who is told
 * only "2 waiting" will reasonably assume both are still answerable.
 */
function WaitingOnYou({ overview }: { overview: RuntimeOverview }) {
  const { pending, overdue } = overview.approvals;
  if (pending === 0) return null;

  return (
    <Card
      className={
        overdue > 0
          ? "border-red-500/40 bg-red-500/[0.04]"
          : "border-amber-500/40 bg-amber-500/[0.04]"
      }
    >
      <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div className="space-y-1">
            <p className="font-medium">
              {pending === 1
                ? "1 post is waiting for you"
                : `${pending} posts are waiting for you`}
            </p>
            <p className="text-sm text-muted-foreground">
              {overdue > 0 ? (
                <>
                  {overdue === 1
                    ? "One of them has already"
                    : `${overdue} of them have already`}{" "}
                  run out of time and will fail. Answering the rest still works.
                </>
              ) : (
                "A run is stopped on each one until you answer."
              )}
            </p>
          </div>
        </div>
        <Button asChild variant={overdue > 0 ? "destructive" : "gold"}>
          <Link href="/approvals">
            Review {pending === 1 ? "it" : "them"}
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Goals that cannot run
// ---------------------------------------------------------------------------

/**
 * Goals that will never fire, named.
 *
 * The count comes from asking which of a goal's target accounts can still
 * publish, not from reading a column on the goal — a goal's targets are a JSON
 * list and whether they can act is a property of the accounts behind them, so
 * the answer cannot be stored and goes stale exactly when it matters.
 *
 * The card links to `/goals` rather than to each goal: this screen's job is to
 * say the thing is true, and a goal that cannot act is visible on the goals
 * screen as a health label on the row.
 */
function BlockedGoals({ overview }: { overview: RuntimeOverview }) {
  if (overview.blockedGoals === 0) return null;

  return (
    <Card className="border-amber-500/40">
      <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
          <div className="space-y-1">
            <p className="font-medium">
              {overview.blockedGoals === 1
                ? "1 active goal will not fire"
                : `${overview.blockedGoals} active goals will not fire`}
            </p>
            <p className="text-sm text-muted-foreground">
              They target an account that is disconnected or switched off. No run
              is created, so nothing will appear in the history to tell you.
            </p>
          </div>
        </div>
        <Button asChild variant="outline">
          <Link href="/goals">
            Open goals
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/** A labelled number. */
function Stat({
  icon: Icon,
  label,
  value,
  hint,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" />
        <span className="text-xs font-medium uppercase tracking-wider">
          {label}
        </span>
      </div>
      <p className="mt-2 text-3xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  );

  if (href) {
    return (
      <Card className="transition-colors hover:border-gold-500/50">
        <CardContent className="py-5">
          <Link href={href} className="block">
            {body}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-5">{body}</CardContent>
    </Card>
  );
}

/**
 * The four numbers that are not asking for anything.
 *
 * Ordered by how often they are the reason a user opened the page — goals, then
 * what the goals are doing — rather than alphabetically or by size. The
 * `recentFailed` tile is the only one that is a count of things being wrong,
 * and it carries the window in its hint because "3 failed" means something very
 * different across three days than across three years.
 */
function Counts({ overview }: { overview: RuntimeOverview }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        icon={Target}
        label="Active goals"
        value={overview.goals.active}
        hint={
          overview.goals.paused > 0
            ? `${overview.goals.paused} paused`
            : "In the schedule"
        }
        href="/goals"
      />
      <Stat
        icon={Activity}
        label="In flight"
        value={overview.runs.inFlight}
        hint="Claimed or executing now"
        href="/runtime?view=running"
      />
      <Stat
        icon={Clock}
        label="Failed this week"
        value={overview.runs.recentFailed}
        hint={`${overview.runs.recent} ran in the last 7 days`}
      />
      <Stat
        icon={Users}
        label="Accounts"
        value={overview.accounts.enabled}
        hint={
          overview.accounts.needsAttention > 0
            ? `${overview.accounts.needsAttention} need reconnecting`
            : `of ${overview.accounts.total} connected`
        }
        href="/accounts"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent runs
// ---------------------------------------------------------------------------

/**
 * The newest runs, across every goal.
 *
 * Capped at eight by the read module. That is a deliberate choice over
 * pagination: the dashboard answers "what has been happening", and eight is
 * enough for that, while the run list is one click away for anyone who wants
 * more. A dashboard that paginates is a dashboard that has become a list with
 * extra steps.
 */
function RecentRuns({ overview }: { overview: RuntimeOverview }) {
  return (
    <section className="space-y-4">
      <SectionHeader
        title="Recent runs"
        description="Every goal, newest first."
        action={
          <Button asChild variant="ghost" size="sm">
            <Link href="/runtime/runs">
              All runs
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        }
      />

      {overview.recentRuns.length === 0 ? (
        <EmptyState
          icon={History}
          title="No runs yet"
          description="A run is created each time one of your goals fires. Create a goal and the first one appears here."
          action={
            <Button asChild variant="gold" size="sm">
              <Link href="/goals/new">Create a goal</Link>
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border/50">
              {overview.recentRuns.map((run) => {
                const status = executionStatus(run.state);
                return (
                  <li key={run.id}>
                    <Link
                      href={`/runs/${run.id}`}
                      className="flex items-center justify-between gap-4 px-6 py-4 transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="truncate font-medium">{run.goalTitle}</p>
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{run.scheduleSlot}</span>
                          <span aria-hidden>·</span>
                          <span>
                            {run.stepCount === 0
                              ? "no steps"
                              : `${run.stepCount} step${run.stepCount === 1 ? "" : "s"}`}
                          </span>
                          {run.attempt > 1 ? (
                            <>
                              <span aria-hidden>·</span>
                              <span>attempt {run.attempt}</span>
                            </>
                          ) : null}
                          <span aria-hidden>·</span>
                          <span>{relativeTime(run.createdAt)}</span>
                        </p>
                      </div>
                      <StatusBadge meta={status} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
