import { CheckCircle2, Clock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ApprovalCard, type ApprovalView } from "@/components/runtime/approval-card";
import { EmptyState, SectionHeader } from "@/components/runtime/empty-state";
import { requireSessionUser } from "@/lib/session";
import { listPendingApprovals } from "@/lib/runtime/approval-store";
import { listGoals } from "@/lib/goals/service";
import { isOverdue } from "@/lib/runtime/approvals";

/**
 * The approval inbox.
 *
 * ## Why it is a list of full cards rather than a table of rows
 *
 * Each of these is a decision about specific content, and the content is the
 * point. A table row showing `publish_post → x:hilbras` is a queue item; a card
 * showing the post is a question. A user asked "may this go out?" cannot answer
 * it from a row, and making them click through to answer is a second step
 * between a person and a decision they were asked to make.
 *
 * ## Why overdue ones sort first
 *
 * An approval past its deadline cannot be answered. The server will refuse it
 * and the step will fail. It is therefore the one entry on this page where the
 * user's action changes nothing, and it is the one most likely to have been
 * sitting here for a long time. Putting it at the top is the difference between
 * a user learning that their window closed and a user learning it only after
 * pressing Approve and being refused.
 *
 * ## Why it reads the goal titles
 *
 * A card saying `publish_post` is answerable but not trustworthy: the same tool
 * against the same account appears for many different goals, and which goal
 * asked is what tells a user whether this post is the one they were expecting.
 * The map is keyed by goal id and falls back to nothing rather than to a
 * placeholder — an unattributed question is honest, a mislabelled one is not.
 */
export default async function ApprovalsPage() {
  const user = await requireSessionUser();

  const [approvals, goals] = await Promise.all([
    listPendingApprovals(user.id),
    listGoals(user.id),
  ]);

  const goalTitles = new Map(goals.map((goal) => [goal.id, goal.title]));
  const now = new Date();

  const views: Array<ApprovalView & { goalTitle?: string; overdue: boolean }> =
    approvals
      .map((approval) => ({
        id: approval.id,
        runId: approval.runId,
        tool: approval.tool,
        targetAccount: approval.targetAccount,
        input: approval.input,
        expiresAt: approval.expiresAt.toISOString(),
        createdAt: approval.createdAt.toISOString(),
        goalTitle: goalTitles.get(approval.runId),
        overdue: isOverdue(approval.expiresAt, now),
      }))
      .sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        return new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
      });

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Posts the Runtime planned and is holding until you say go ahead.
        </p>
      </header>

      {views.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Nothing is waiting"
          description="When a goal needs your approval before publishing, the post appears here. Nothing needs one right now."
        />
      ) : (
        <section className="space-y-4">
          <SectionHeader
            title={`${views.length} waiting`}
            description={
              views.some((view) => view.overdue)
                ? "Some have already run out of time and will fail without an answer."
                : "Oldest deadline first."
            }
          />
          <div className="space-y-4">
            {views.map((view) => (
              <ApprovalCard
                key={view.id}
                approval={view}
                {...(view.goalTitle ? { goalTitle: view.goalTitle } : {})}
              />
            ))}
          </div>
        </section>
      )}

      <HowItWorks />
    </div>
  );
}

/**
 * What an approval is, for someone meeting the screen for the first time.
 *
 * Three sentences, and each one is a fact a user would otherwise have to
 * discover by being wrong: what is being held, how long the window is, and
 * what a rejection does. The last is the one that surprises people — rejecting
 * one step does not cancel the run, and a user who believes otherwise will
 * decline to reject anything for fear of stopping the whole thing.
 */
function HowItWorks() {
  return (
    <Card className="border-border/60">
      <CardContent className="space-y-3 py-5 text-sm text-muted-foreground">
        <p className="flex items-start gap-2">
          <Clock className="mt-0.5 size-4 shrink-0" />
          <span>
            Each question stays open for 24 hours. If nobody answers, the step
            fails — the Runtime never publishes something you did not see.
          </span>
        </p>
        <p>
          Rejecting one post does not cancel the run. It skips that step and the
          rest of the plan continues, so a post aimed at one account can be
          declined while the others still go out.
        </p>
        <p>
          You can change what a post says before approving it, but only the text:
          not the account, not the media.{" "}
          <Button asChild variant="link" className="h-auto p-0">
            <a href="/docs/approvals">How approvals work</a>
          </Button>
        </p>
      </CardContent>
    </Card>
  );
}
