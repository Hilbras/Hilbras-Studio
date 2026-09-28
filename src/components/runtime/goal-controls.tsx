"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive, Loader2, Pause, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { setGoalStatusAction } from "@/app/actions/goals";
import type { GoalStatus } from "@/lib/goals/validation";

/**
 * Pause, resume, or archive a goal.
 *
 * ## Why these are not form fields
 *
 * A goal's *configuration* is values — a title, a cron, a set of accounts — and
 * saving it is editing. Its *status* is a decision with consequences the user
 * may not have intended, and putting it in the same form as the title means one
 * careless Save pauses a goal that was running. So these are separate buttons,
 * and none of them is reachable by submitting the configuration form.
 *
 * ## Why archiving is confirmed and the others are not
 *
 * Archiving is the only irreversible one: `setGoalStatus` refuses to revive an
 * archived goal, because a re-creation with the same id and a history that no
 * longer matches is a different thing wearing the same name. A destructive
 * action that is also irreversible gets a confirmation. Pausing does not, and a
 * confirmation there is friction the user has not earned — it is one click to
 * undo.
 *
 * ## Why the label follows the server, not the click
 *
 * `setGoalStatus` refuses an archived goal's revival, and refuses to resume a
 * goal whose stored cron no longer parses. A button that switched to "Resume"
 * the instant it was pressed would be promising something the server had
 * already declined. So the local status only advances when the action came back
 * `ok`, and a refusal is shown in full — those two refusals are the user
 * hitting a real limit, and "could not update" would send them looking for
 * something else to blame.
 *
 * The router refresh after a success is what makes the rest of the page — the
 * next firing, the history — agree with the database rather than with this
 * component. The action already revalidated; the refresh is the client half of
 * that.
 */
export function GoalControls({
  goalId,
  status,
}: {
  goalId: string;
  status: GoalStatus;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<GoalStatus | null>(null);
  const [outcome, setOutcome] = React.useState<{
    ok: boolean;
    message: string;
    /** The status the server settled on, when it settled. `null` on a refusal. */
    status: GoalStatus | null;
  } | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  // Only ever the status the server has confirmed. `status` is what the page
  // rendered with, which is what was in the database when it was rendered.
  const current = outcome?.ok ? (outcome.status ?? status) : status;

  async function change(next: GoalStatus) {
    setPending(next);
    setOutcome(null);
    try {
      const data = new FormData();
      data.set("goalId", goalId);
      data.set("status", next);
      const result = await setGoalStatusAction(null, data);
      setOutcome(
        result.ok
          ? { ok: true, message: result.message, status: next }
          : { ok: false, message: result.message, status: null },
      );
      if (result.ok) router.refresh();
    } finally {
      setPending(null);
      setConfirming(false);
    }
  }

  const busy = pending !== null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {current === "active" ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void change("paused")}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Pause className="size-4" />
          )}
          Pause
        </Button>
      ) : null}

      {current === "paused" ? (
        <Button
          variant="gold"
          disabled={busy}
          onClick={() => void change("active")}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          Resume
        </Button>
      ) : null}

      {current === "archived" ? (
        <p className="text-sm text-muted-foreground">
          Archived goals cannot be resumed. Create the goal again if you want it
          back.
        </p>
      ) : confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-1.5">
          <span className="text-sm text-red-600 dark:text-red-400">
            Archive this goal? Its history is kept, but it cannot be resumed.
          </span>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => void change("archived")}
          >
            Archive
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <Button variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>
          <Archive className="size-4" />
          Archive
        </Button>
      )}

      {outcome ? (
        <p
          role="status"
          aria-live="polite"
          className={
            outcome.ok
              ? "text-sm text-emerald-600 dark:text-emerald-400"
              : "text-sm text-red-600 dark:text-red-400"
          }
        >
          {outcome.message}
        </p>
      ) : null}
    </div>
  );
}
