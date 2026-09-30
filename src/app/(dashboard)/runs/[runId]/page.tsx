import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApprovalCard, type ApprovalView } from "@/components/runtime/approval-card";
import { SectionHeader } from "@/components/runtime/empty-state";
import { ExecutionBadge, StatusBadge } from "@/components/runtime/status-badge";
import { requireSessionUser } from "@/lib/session";
import { getRunDetail } from "@/lib/runtime/queries";
import { getTool } from "@/lib/runtime/tools";
import { executionStatus, formatInstant, relativeTime } from "@/lib/runtime/view";

/**
 * One run: its steps, its log, and the question it is waiting on.
 *
 * ## What this page is
 *
 * The Runtime's only diagnostic surface, and the answer to "why did my post not
 * go out". It shows three things in the order they are diagnosed: what the run
 * did (steps), what the Runtime recorded while doing it (events), and whether it
 * is stopped asking something (the approval).
 *
 * ## Why the content is shown, and why that is safe here
 *
 * A run's steps carry their input and their result — the actual post text, the
 * URL the platform returned. That is the reason the page exists: a user asking
 * what went out needs to see what went out, and a connector error with the
 * platform's own words in it is usually the whole diagnosis.
 *
 * It is safe because the run is the caller's own. `getRunDetail` puts
 * `runs.userId` in the `WHERE` clause, so a run that is not theirs is not
 * returned at all rather than returned and filtered — the page has no branch
 * that could render somebody else's run.
 *
 * ## Why a pending approval is rendered from the row, not the run state
 *
 * The run says `awaiting_approval`, and the approval row says `pending`. They
 * are written by two different statements, and the approval is settled *first*:
 * between a decision and the resume that acts on it, the run is still
 * `awaiting_approval` while the question has been answered. Reading the row
 * rather than the state is what stops this page showing a question that no
 * longer exists — with a live Approve button on it.
 */
export default async function RunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const user = await requireSessionUser();

  const detail = await getRunDetail(user.id, runId);
  if (!detail) notFound();

  const { run, steps, events, pendingApproval } = detail;
  const status = executionStatus(run.state);

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/goals">
            <ArrowLeft className="size-4" />
            {run.goalTitle}
          </Link>
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Run</h1>
            <p className="font-mono text-sm text-muted-foreground">
              {run.scheduleSlot}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusBadge meta={status} />
            {run.attempt > 1 ? (
              <Badge variant="quiet">Attempt {run.attempt}</Badge>
            ) : null}
          </div>
        </div>

        <p className="max-w-2xl text-sm text-muted-foreground">{status.meaning}</p>

        {run.errorSummary ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/[0.06] p-3 text-sm text-red-600 dark:text-red-400">
            {run.errorSummary}
          </div>
        ) : null}
      </header>

      {pendingApproval ? (
        <section className="space-y-4">
          <SectionHeader
            title="Waiting on you"
            description="This run is stopped until you answer."
          />
          <ApprovalCard
            approval={
              {
                id: pendingApproval.id,
                runId: run.id,
                tool: pendingApproval.tool,
                targetAccount: pendingApproval.targetAccount,
                input: pendingApproval.input,
                expiresAt: pendingApproval.expiresAt.toISOString(),
                // The row this page read has no `createdAt`; the window is a
                // fixed 24h from creation, so the bar is derived from the
                // deadline alone rather than from a timestamp this read does
                // not carry. The card falls back to APPROVAL_WINDOW_MS when
                // these are equal, which is the same number.
                createdAt: new Date(
                  pendingApproval.expiresAt.getTime() - APPROVAL_WINDOW_MS,
                ).toISOString(),
              } satisfies ApprovalView
            }
            goalTitle={run.goalTitle}
          />
        </section>
      ) : null}

      <section className="space-y-4">
        <SectionHeader
          title="Steps"
          description={
            run.stepCount === 0
              ? "No plan was produced for this run."
              : `${run.stepCount} step${run.stepCount === 1 ? "" : "s"}, in plan order.`
          }
        />
        {steps.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              This run has no steps. It either never got as far as planning, or
              the planner returned nothing.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {steps.map((step) => (
              <StepCard key={step.id} step={step} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeader
          title="Log"
          description={`${events.length} event${events.length === 1 ? "" : "s"}, oldest first.`}
        />
        {events.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nothing was recorded for this run.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <ul className="divide-y divide-border/50 font-mono text-xs">
                {events.map((event) => (
                  <li
                    key={event.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-6 py-2.5"
                  >
                    <span className="shrink-0 text-muted-foreground/85">
                      {event.at.toISOString().slice(11, 19)}
                    </span>
                    <LevelDot level={event.level} />
                    <span
                      className={
                        event.level === "error"
                          ? "text-red-500"
                          : event.level === "warn"
                            ? "text-amber-500"
                            : undefined
                      }
                    >
                      {event.event}
                    </span>
                    {event.detail ? (
                      <span className="min-w-0 flex-1 break-all text-muted-foreground">
                        {event.detail}
                      </span>
                    ) : null}
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

const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One log line's severity, as a colour. */
function LevelDot({ level }: { level: string }) {
  const colour =
    level === "error"
      ? "bg-red-500"
      : level === "warn"
        ? "bg-amber-500"
        : level === "debug"
          ? "bg-muted-foreground/40"
          : "bg-muted-foreground/70";
  return <span className={`size-1.5 shrink-0 rounded-full ${colour}`} />;
}

/**
 * One step, with what it was given and what it returned.
 *
 * The content is in a collapsed section rather than always visible. A run with
 * eight steps is mostly prose about posts the user wrote, and a page that shows
 * all of it unprompted buries the one step that failed. The disclosure is
 * closed by default and the step's state is always shown, so the summary is
 * scannable and the detail is one click away.
 */
function StepCard({
  step,
}: {
  step: {
    id: string;
    stepIndex: number;
    label: string;
    capability: string;
    targetAccount: string | null;
    state: string;
    input: string | null;
    result: string | null;
    error: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
  };
}) {
  const tool = getTool(step.capability);
  const status = executionStatus(step.state);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-sm font-medium">
              <span className="mr-2 text-muted-foreground tabular-nums">
                {step.stepIndex}
              </span>
              {step.label}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {step.capability}
              {step.targetAccount ? ` → ${step.targetAccount}` : ""}
              {tool?.summary ? ` — ${tool.summary}` : ""}
            </p>
          </div>
          <ExecutionBadge state={step.state} />
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {step.error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/[0.06] p-3 text-sm text-red-600 dark:text-red-400">
            {formatError(step.error)}
          </div>
        ) : null}

        {step.input || step.result ? (
          <details className="group">
            <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground hover:text-foreground">
              <span className="group-open:hidden">Show what went in and out</span>
              <span className="hidden group-open:inline">Hide</span>
            </summary>
            <div className="mt-2 space-y-2">
              {step.input ? <Json label="Input" value={step.input} /> : null}
              {step.result ? <Json label="Result" value={step.result} /> : null}
            </div>
          </details>
        ) : null}

        {step.startedAt || step.finishedAt ? (
          <p className="text-xs text-muted-foreground">
            {step.startedAt ? `Started ${relativeTime(step.startedAt)}` : null}
            {step.startedAt && step.finishedAt ? " · " : null}
            {step.finishedAt ? `finished ${formatInstant(step.finishedAt)}` : null}
          </p>
        ) : null}

        {step.state === "awaiting_approval" ? (
          <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            Waiting on an approval. It will fail if nobody answers before the
            window closes.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * A stored JSON blob, pretty-printed.
 *
 * Pretty-printed on the server rather than in the browser so the value is
 * formatted identically in every environment, and so a malformed blob can be
 * shown as the raw text it is rather than throwing during render.
 */
function Json({ label, value }: { label: string; value: string }) {
  let shown = value;
  try {
    shown = JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    // Shown raw. A column that is not JSON is a thing to look at, not a reason
    // to render nothing.
  }

  return (
    <div className="space-y-1">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <pre className="max-h-72 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 text-xs whitespace-pre-wrap break-all">
        {shown}
      </pre>
    </div>
  );
}

/** A step's stored error, read as JSON if it is a typed connector error. */
function formatError(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const message = record.message ?? record.error ?? record.reason;
      if (typeof message === "string") {
        const code = record.code;
        return typeof code === "string" ? `${message} (${code})` : message;
      }
    }
  } catch {
    // Not JSON — shown as stored.
  }
  return raw;
}
