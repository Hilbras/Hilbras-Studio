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

import { and, asc, eq, lt, sql } from "drizzle-orm";
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

// Deliberately *not* `reject` or `approval_timeout`. Both resume a run in v0.8.0
// — a decision about one step is not a conclusion about the run — so stamping
// `finished_at` on them would mark a run finished while it was still executing
// the steps the user did not object to.
const FINISHES_RUN: ReadonlySet<ExecutionEvent["type"]> = new Set([
  "succeed",
  "fail",
  "cancel",
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

  // Narrowed, because only `fail` carries a summary and reading it off the
  // union is exactly the sort of thing that silently becomes `undefined` for
  // every other event type.
  const summary = event.type === "fail" ? event.summary : undefined;

  await db
    .update(runs)
    .set({
      state: result.to,
      ...(STARTS_RUN.has(event.type) ? { startedAt: new Date() } : {}),
      ...(FINISHES_RUN.has(event.type) ? { finishedAt: new Date() } : {}),
      // Only on failure, and only when the caller had something to say. Writing
      // a null over an earlier attempt's summary on a later `succeed` would be
      // wrong — the column describes why this run ended, and a run that ended
      // well did not fail.
      ...(result.to === "failed" && summary ? { errorSummary: summary } : {}),
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

/**
 * Take a step for execution, or report that someone else already has it.
 *
 * A compare-and-swap on the state: the update applies only from a state the
 * caller expected, and the `returning` clause says whether it applied. That is
 * what makes a step safe to execute when two invocations can reach it — and two
 * can, since v0.8.0 added a resume trigger alongside the scheduler's, and a
 * queue retry of the resume can overlap the resume the sweeper sent.
 *
 * Reading the state and then updating it is not the same thing. The gap between
 * the two is wide enough for both invocations to see `awaiting_approval`, and both
 * would dispatch a publish. The step's idempotency key would not save it: that
 * key is what a *connector* uses to absorb a duplicate, and it only works for
 * connectors that implement the cache, which not all of them do.
 */
/**
 * How long a step's claim is honoured before another invocation may take it.
 *
 * **A claim is a lease, not a flag**, and this is how long it runs.
 *
 * `claimStep` is a compare-and-swap from whatever state the caller *read*, and
 * the caller reads the live row. So a step observed as `running` can be "claimed"
 * from `running` to `running` — and the queue is at-least-once, so a redelivery
 * of the same event starts a second invocation while the first is still inside
 * the step body. Both execute it, and both publish. The step's idempotency key
 * does not save it: that only helps connectors which implement the receipt cache,
 * and not all of them do.
 *
 * So a `running` step is not claimable — until this much time has passed, at
 * which point the worker holding it is presumed gone. `releaseStepClaim` covers
 * the recoverable crash (a `catch` runs); it does not cover a worker killed
 * outright, and without a lease, refusing `running` outright would trade a
 * double-execution bug for a permanently stuck run.
 *
 * Five minutes is generous on purpose. A model call is bounded at 30s and a
 * publish is bounded by the connector timeout, so a step that is still `running`
 * after this long is not slow — it is gone. It is also the approval sweeper's
 * cadence, so a reclaimed step is noticed on the same tick a lapsed approval is.
 */
export const STEP_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Take a step's claim, or report that someone else holds it.
 *
 * `from` is the state the caller observed, not a fixed expectation. The two
 * rules that fall out of that:
 *
 *  - A step observed in any non-`running` state is claimable, and the swap makes
 *    exactly one caller win.
 *  - A step observed `running` is claimable only once its claim is older than
 *    `STEP_CLAIM_LEASE_MS`. See that constant for why.
 */
export async function claimStep(
  stepId: string,
  from: ExecutionState,
  now: Date = new Date(),
): Promise<boolean> {
  const claimed = await db
    .update(runSteps)
    .set({ state: "running", startedAt: now })
    .where(
      and(
        eq(runSteps.id, stepId),
        eq(runSteps.state, from),
        from === "running"
          ? lt(runSteps.startedAt, new Date(now.getTime() - STEP_CLAIM_LEASE_MS))
          : undefined,
      ),
    )
    .returning({ id: runSteps.id });

  return claimed.length > 0;
}

/**
 * Put a step back into a settled state from `running`.
 *
 * The counterpart to `claimStep`, and needed because a claim is a reservation:
 * once taken, nothing else will execute that step, so a crash between claiming
 * and dispatching would leave it `running` and unrecoverable for the lease.
 *
 * Returns it to the *original* state rather than to `failed`, so the queue's
 * retry is a clean second look. A step left `failed` would be skipped as
 * terminal and the run would report success having published nothing.
 *
 * This covers the crash that a `catch` can reach. A worker killed outright does
 * not run a `catch`, and is covered by `STEP_CLAIM_LEASE_MS` instead. Both are
 * needed: release makes a recoverable failure immediate, and the lease makes an
 * unrecoverable one eventual.
 *
 * Called when execution cannot even be attempted, which after a successful claim
 * means a defect rather than a plan problem, and is recorded as one.
 */
export async function releaseStepClaim(
  runId: string,
  stepId: string,
  to: ExecutionState,
  detail: unknown,
): Promise<void> {
  const released = await db
    .update(runSteps)
    .set({ state: to })
    .where(and(eq(runSteps.id, stepId), eq(runSteps.state, "running")))
    .returning({ id: runSteps.id });

  if (released.length === 0) return;

  await recordEvent(runId, {
    stepId,
    level: "warn",
    event: "step.claim_released",
    detail,
  });
}

/**
 * Move a step into `awaiting_approval` and record the question.
 *
 * Separate from `settleStep` because a suspension is not an outcome: the step
 * produced nothing, and it will produce something only if a person says so. It
 * also leaves `finishedAt` null, because the step is not finished — it is
 * waiting, and the two mean different things to anything reading the run.
 */
export async function suspendStep(
  runId: string,
  stepId: string,
  approval: { id: string; expiresAt: Date },
): Promise<void> {
  const suspended = await db
    .update(runSteps)
    .set({ state: "awaiting_approval" })
    .where(eq(runSteps.id, stepId))
    .returning({ id: runSteps.id });

  if (suspended.length === 0) return;

  await recordEvent(runId, {
    stepId,
    level: "info",
    event: "step.awaiting_approval",
    detail: {
      approvalId: approval.id,
      expiresAt: approval.expiresAt.toISOString(),
    },
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

/**
 * The idempotency key for one step of one run (ADR-005).
 *
 * Derived from `(runId, stepIndex, targetAccount)`, exactly as the schema says.
 * Two details are load-bearing:
 *
 * - **`stepIndex` is in the key**, so a plan that publishes twice to the same
 *   account is two dispatches, not one. Without it the second would be absorbed
 *   as a duplicate of the first and the user would get one post where they
 *   asked for two.
 * - **`targetAccount` is in the key too**, so moving a step between accounts
 *   can never collide with the step it replaced.
 *
 * A step with no account gets `"none"` rather than an empty string, so the key
 * never has a segment that could be confused with one.
 */
export function stepIdempotencyKey(
  runId: string,
  stepIndex: number,
  targetAccount: string | null | undefined,
): string {
  return `run:${runId}:${stepIndex}:${targetAccount ?? "none"}`;
}

export interface PersistPlanResult {
  /** False when the run already had steps — a redelivery, or a resumed plan. */
  created: boolean;
  stepCount: number;
}

/**
 * Write a validated plan to a run.
 *
 * Refuses to run twice rather than replacing what is there. The first write is
 * the plan that will execute; a second call means the planning step was
 * redelivered by the queue, and the right response to that is to leave the
 * original alone and let execution continue. Overwriting would be a way for a
 * redelivery to change the content a run is about to publish, which is the one
 * thing the at-least-once queue must never be able to do (ADR-005).
 *
 * Both statements are in one transaction: a run with `plan` set and no steps, or
 * steps and no plan, is a state no reader here is prepared for.
 */
export async function persistPlan(
  runId: string,
  plan: unknown,
  steps: readonly {
    stepIndex: number;
    label: string;
    capability: string;
    targetAccount?: string | null;
    input?: unknown;
  }[],
): Promise<PersistPlanResult> {
  const [existing] = await db
    .select({ id: runSteps.id })
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .limit(1);
  if (existing) return { created: false, stepCount: steps.length };

  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ plan: JSON.stringify(plan) })
      .where(eq(runs.id, runId));

    if (steps.length > 0) {
      await tx.insert(runSteps).values(
        steps.map((step) => ({
          id: randomUUID(),
          runId,
          stepIndex: step.stepIndex,
          label: step.label,
          capability: step.capability,
          targetAccount: step.targetAccount ?? null,
          state: "pending",
          input:
            step.input === undefined ? null : JSON.stringify(step.input),
          idempotencyKey: stepIdempotencyKey(
            runId,
            step.stepIndex,
            step.targetAccount,
          ),
        })),
      );
    }
  });

  return { created: true, stepCount: steps.length };
}

/** How many steps a run has. Used to tell a planned run from a bare one. */
export async function countRunSteps(runId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runSteps)
    .where(eq(runSteps.runId, runId));
  return row?.count ?? 0;
}

/** Full history of a run, oldest first. This is the runtime log. */
export async function listRunEvents(runId: string) {
  return db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.at));
}

/** The run itself. The planner needs its owner and goal before anything else. */
export async function getRun(runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return row ?? null;
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

