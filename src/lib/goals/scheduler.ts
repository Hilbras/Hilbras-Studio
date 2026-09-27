/**
 * The goal scheduler.
 *
 * ## The missing link
 *
 * `executeGoalRun` in `lib/runtime/inngest` waits for a `GOAL_SCHEDULED` event.
 * Until Phase 4, nothing sent one. The Runtime was complete and dark: a goal
 * row could be inserted by hand and the function would sit there forever,
 * correct and idle. This module is what makes a schedule mean something.
 *
 * ## The order of operations, and why it is that way
 *
 * For each due goal: **advance first, then dispatch.**
 *
 * The alternative — dispatch, then advance — looks more natural and is worse. If
 * the process dies between the two, the goal is still due on the next tick and
 * the scheduler sends the same slot again. That is *survivable*, because the
 * run's unique idempotency key absorbs it as a redelivery (ADR-005), but it is
 * wasted work on a loop that never gets past the slot that killed it.
 *
 * Advancing first cannot double-publish. If the process dies before the
 * dispatch, the slot is skipped and one firing is lost — visible, bounded, and
 * strictly better than a scheduler that wedges. `advanceGoal` computes the next
 * slot from `now` rather than from the slot just handled, so firings missed
 * while the deploy was down collapse into one run instead of arriving as a
 * burst the moment it returns.
 *
 * ## What this module does not do
 *
 * It does not create the run. `executeGoalRun` claims the run, because the
 * queue's at-least-once delivery is the only thing that can reliably detect a
 * duplicate dispatch. Creating it here would put idempotency in two places and
 * make the second one the weaker of the pair.
 *
 * It also does not record a failed dispatch. There is no run to attach the event
 * to — the run does not exist until the function claims it — so the failure is
 * returned in the summary, which the Inngest function returns as its output and
 * the dashboard reads. Attaching it to the goal's *most recent* run instead
 * would be worse than not recording it: it would attribute a scheduling failure
 * to a run that had already finished.
 *
 * ## The dependency arrow
 *
 * The event *producer* is injected. This module decides **which** goals are due
 * and **what slot** each is due for; it does not know what a queue is. That is
 * what makes the catch-up policy testable with a plain function.
 */

import "server-only";

import { slotKey } from "./cron";
import { advanceGoal, listDueGoals } from "./service";

/** A goal that was due, and what became of it. */
export interface DispatchResult {
  goalId: string;
  /** The slot this firing belongs to, stable across repeated dispatches. */
  scheduleSlot: string;
  dispatched: boolean;
  reason?:
    /** The schedule no longer parses or never comes round. */
    | "unschedulable"
    /** The queue rejected the event. The slot has been advanced past. */
    | "send_failed";
}

export interface DispatchSummary {
  due: number;
  dispatched: number;
  skipped: number;
  results: DispatchResult[];
}

export type EventSender = (event: {
  goalId: string;
  userId: string;
  scheduleSlot: string;
  attempt: number;
}) => Promise<void>;

/**
 * Dispatch every goal that is currently due.
 *
 * `now` is a parameter rather than `new Date()` so a caller can replay a
 * specific moment and the tests do not have to wait for the clock to move.
 */
export async function dispatchDueGoals(
  send: EventSender,
  now: Date = new Date(),
): Promise<DispatchSummary> {
  const due = await listDueGoals(now);
  const results: DispatchResult[] = [];

  for (const goal of due) {
    // Derived from the stored firing time, not from `now`. Two dispatches at the
    // same tick therefore produce the same idempotency key, and the second is
    // absorbed rather than publishing twice.
    const scheduleSlot = slotKey(goal.dueAt);

    const next = await advanceGoal(goal.id, now);

    if (next === null) {
      // The schedule no longer parses, or can never fire. The goal is left in
      // place for the user to see and fix rather than archived on their behalf,
      // and it stops being selected because its firing time is now NULL.
      results.push({
        goalId: goal.id,
        scheduleSlot,
        dispatched: false,
        reason: "unschedulable",
      });
      continue;
    }

    try {
      await send({
        goalId: goal.id,
        userId: goal.userId,
        scheduleSlot,
        attempt: 1,
      });
      results.push({ goalId: goal.id, scheduleSlot, dispatched: true });
    } catch (cause) {
      // The slot is already advanced, so this firing is lost rather than
      // retried into a duplicate. Surfaced in the summary because "my goal did
      // not run" is otherwise invisible until the user notices the missing post.
      console.error("[goals] dispatch failed", {
        goalId: goal.id,
        scheduleSlot,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      results.push({
        goalId: goal.id,
        scheduleSlot,
        dispatched: false,
        reason: "send_failed",
      });
    }
  }

  return {
    due: results.length,
    dispatched: results.filter((r) => r.dispatched).length,
    skipped: results.filter((r) => !r.dispatched).length,
    results,
  };
}
