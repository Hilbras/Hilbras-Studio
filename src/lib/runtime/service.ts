/**
 * Runtime persistence — the only module that writes run state.
 *
 * Everything here is server-only. The rule it exists to enforce is ADR-003:
 * execution state is server-authoritative. A transition is computed from the
 * current state and an event, applied here, and written alongside the event it
 * records — so the history can never disagree with the state.
 *
 * The function worth reading closely is `createRun`. The queue is
 * at-least-once, so the same goal can be delivered to the executor twice for
 * one schedule slot. `runs.idempotencyKey` is UNIQUE, and a redelivery is
 * absorbed by that constraint rather than by a read-then-write race. The
 * distinction matters: a check followed by an insert has a window between
 * them, and two concurrent deliveries both pass the check.
 */

import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { goals, runEvents, runs, runSteps } from "@/db/schema";

import {
  transition,
  type ExecutionEvent,
  type ExecutionState,
} from "./state";

export type CreateRunResult =
  | { created: true; runId: string }
  /** A run already exists for this goal and slot — a queue redelivery. */
  | { created: false; runId: string; reason: "duplicate_delivery" };

/**
 * The idempotency key for a scheduled firing.
 *
 * Includes the slot, so the same goal firing twice on purpose at two different
 * times is two runs, while the same slot delivered twice is one.
 */
export function runIdempotencyKey(
  goalId: string,
  scheduleSlot: string,
): string {
  return `goal:${goalId}:${scheduleSlot}`;
}

function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: string }).code === "23505"
  );
}

export interface RecordEventInput {
  level?: "debug" | "info" | "warn" | "error";
  event: string;
  stepId?: string | null;
  detail?: unknown;
}

/** Append to the run's history. */
export async function recordEvent(
  runId: string,
  input: RecordEventInput,
): Promise<void> {
  await db.insert(runEvents).values({
    id: randomUUID(),
    runId,
    stepId: input.stepId ?? null,
    level: input.level ?? "info",
    event: input.event,
    detail: input.detail === undefined ? null : JSON.stringify(input.detail),
  });
}

/**
 * Create a run for a goal firing, or report the existing one.
 *
 * Returns `created: false` rather than throwing on a duplicate, because the
 * correct response to a redelivery is to stop — not to raise an alert.
 */
export async function createRun(input: {
  goalId: string;
  scheduleSlot: string;
  attempt?: number;
}): Promise<CreateRunResult> {
  const [goal] = await db
    .select({ id: goals.id, userId: goals.userId, status: goals.status })
    .from(goals)
    .where(eq(goals.id, input.goalId))
    .limit(1);

  if (!goal) throw new Error(`Unknown goal ${input.goalId}`);

  // A paused or archived goal must not produce new work, even if the queue
  // still holds a message scheduled before the pause.
  if (goal.status !== "active") {
    throw new Error(`Goal ${input.goalId} is ${goal.status}, not active`);
  }

  const runId = randomUUID();
  const key = runIdempotencyKey(input.goalId, input.scheduleSlot);

  try {
    await db.insert(runs).values({
      id: runId,
      goalId: goal.id,
      userId: goal.userId,
      idempotencyKey: key,
      scheduleSlot: input.scheduleSlot,
      attempt: input.attempt ?? 1,
      state: "pending",
    });
  } catch (cause) {
    // 23505 = unique_violation. Any other database error is a real failure and
    // must not be mistaken for a redelivery.
    if (isUniqueViolation(cause)) {
      const [existing] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.idempotencyKey, key))
        .limit(1);
      if (existing) {
        return {
          created: false,
          runId: existing.id,
          reason: "duplicate_delivery",
        };
      }
    }
    throw cause;
  }

  await recordEvent(runId, { level: "info", event: "run.created" });
  return { created: true, runId };
}


/** Events that start or finish a run, and therefore stamp a timestamp. */
const STARTS_RUN: ReadonlySet<ExecutionEvent["type"]> = new Set(["start"]);
const FINISHES_RUN: ReadonlySet<ExecutionEvent["type"]> = new Set([
  "succeed",
  "fail",
  "cancel",
  "reject",
  "approval_timeout",
]);

/**
 * Apply an event to a run's state and record it, or refuse.
 *
 * Returns the resulting state, or `null` when the event does not apply — which
 * means the caller's view of the run is stale. That is recorded as a warning
 * event rather than thrown, so a redelivered step cannot crash a run that has
 * already finished on its own.
 */
export async function transitionRun(
  runId: string,
  event: ExecutionEvent,
): Promise<ExecutionState | null> {
  const [run] = await db
    .select({ state: runs.state })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (!run) throw new Error(`Unknown run ${runId}`);

  const result = transition(run.state as ExecutionState, event);
  if (!result.ok) {
    await recordEvent(runId, {
      level: "warn",
      event: "run.transition_refused",
      detail: { from: run.state, attempted: event.type },
    });
    return null;
  }

  await db
    .update(runs)
    .set({
      state: result.to,
      ...(STARTS_RUN.has(event.type) ? { startedAt: new Date() } : {}),
      ...(FINISHES_RUN.has(event.type) ? { finishedAt: new Date() } : {}),
    })
    .where(eq(runs.id, runId));

  await recordEvent(runId, {
    event: `run.${event.type}`,
    detail: { from: result.from, to: result.to },
  });

  return result.to;
}

/** Persist a step's terminal outcome, and the event that explains it. */
export async function settleStep(
  runId: string,
  stepId: string,
  outcome: { state: ExecutionState; result?: unknown; error?: unknown },
): Promise<void> {
  await db
    .update(runSteps)
    .set({
      state: outcome.state,
      result:
        outcome.result === undefined ? null : JSON.stringify(outcome.result),
      error: outcome.error === undefined ? null : JSON.stringify(outcome.error),
      startedAt: new Date(),
      finishedAt: new Date(),
    })
    .where(eq(runSteps.id, stepId));

  await recordEvent(runId, {
    stepId,
    level: outcome.state === "completed" ? "info" : "error",
    event: `step.${outcome.state}`,
    detail: outcome.error ?? outcome.result,
  });
}

/** Steps of a run, in plan order. */
export async function listRunSteps(runId: string) {
  return db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .orderBy(asc(runSteps.stepIndex));
}

/** Full history of a run, oldest first. This is the runtime log. */
export async function listRunEvents(runId: string) {
  return db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.at));
}

/**
 * How many runs exist for a goal in one schedule slot.
 *
 * Exists so the redelivery path can be asserted directly, rather than inferred
 * from a caught constraint error.
 */
export async function countRunsInSlot(
  goalId: string,
  scheduleSlot: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.goalId, goalId), eq(runs.scheduleSlot, scheduleSlot)));
  return row?.count ?? 0;
}

/** Active goal ids for a user — the scheduler's work list. */
export async function listActiveGoalIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.status, "active")));
  return rows.map((r) => r.id);
}

