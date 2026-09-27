/**
 * The Runtime's durable function.
 *
 * Inngest owns the retry, the backoff, and the crash recovery; this module owns
 * what a single attempt does. The split is deliberate — the executor decides
 * *whether* a retry is warranted (from `ConnectorError.retryable`) and throws
 * only when it is, letting the queue's own policy govern the actual timing.
 *
 * Every attempt runs these steps in order:
 *
 *   1. claim or absorb the run  — `createRun` is idempotent, so a redelivery
 *      stops here instead of publishing twice
 *   2. transition pending -> running
 *   3. execute each step through the connector
 *   4. settle the run from the step outcomes
 *
 * A step that fails does not abort the others. A goal that publishes to two
 * accounts should publish to the one that still works, and report the one that
 * did not — the same "settle each target independently" rule the v0.1.0
 * composer already follows.
 */

import { NonRetriableError } from "inngest";

import { dispatchDueGoals as dispatchDueGoalsImpl } from "@/lib/goals/scheduler";

import { executeStep, resolverForUser, type ExecutorDeps } from "../executor";
import {
  createRun,
  listRunSteps,
  recordEvent,
  settleStep,
  transitionRun,
} from "../service";
import { isTerminal, type ExecutionState } from "../state";

import { GOAL_SCHEDULED, inngest } from "./client";

/** Give up after this many attempts; the run stays failed and visible. */
const MAX_ATTEMPTS = 3;

/**
 * How often the scheduler looks for due goals.
 *
 * Every five minutes, so the worst a user sees is a firing up to five minutes
 * late. Inngest runs this rather than a Vercel cron because the queue is already
 * the system that owns execution (ADR-001) — a second scheduler with its own
 * secret, its own timeout budget, and its own idea of what is running would be
 * a second source of truth about work in flight.
 *
 * This is a poll, not a queue. Inngest's own cron support would deliver a timer
 * per goal, which needs a durable job store per goal and gives up the single
 * query that makes "which goals are due" one index scan.
 */
const SCHEDULER_TICK = "*/5 * * * *";

export const executeGoalRun = inngest.createFunction(
  {
    id: "execute-goal-run",
    retries: MAX_ATTEMPTS,
    // Inngest v4 takes the trigger inside the options, not as a second
    // positional argument.
    triggers: [{ event: GOAL_SCHEDULED }],
  },
  async ({ event, step }) => {
    const { goalId, scheduleSlot, attempt } = event.data;

    // --- 1. claim the run -------------------------------------------------
    // Inside a `step` so Inngest persists the outcome: a crash after this
    // replays it without creating a second run.
    const claim = await step.run("claim-run", async () => {
      const result = await createRun({ goalId, scheduleSlot, attempt });
      if (!result.created) {
        await recordEvent(result.runId, {
          level: "warn",
          event: "run.redelivery_ignored",
          detail: { scheduleSlot },
        });
      }
      return result;
    });

    if (!claim.created) {
      // A redelivery of a slot we already ran. Nothing to do — returning
      // normally keeps it from being retried into a duplicate publish.
      return { runId: claim.runId, outcome: "already_ran" as const };
    }

    const runId = claim.runId;

    // Resolve connectors through the accounts table, not the account key's
    // prefix. The queue owns the user for this run, so the resolver is built
    // once here rather than per step — and, unlike the registry-only default,
    // it refuses a disabled or unknown account instead of publishing anyway.
    const deps: ExecutorDeps = { resolveConnector: resolverForUser(event.data.userId) };

    // --- 2. start ---------------------------------------------------------
    const started = await step.run("start-run", () =>
      transitionRun(runId, { type: "start" }),
    );
    if (started === null) {
      return { runId, outcome: "not_startable" as const };
    }

    // --- 3. execute the steps --------------------------------------------
    const steps = await step.run("load-steps", () => listRunSteps(runId));

    // A run with no steps is not a successful no-op.
    //
    // Nothing writes `run_steps` yet — that is Phase 5's planner, which turns a
    // goal's statement into a plan. Until then a goal would fire, execute
    // nothing, and report `completed`, which is the single worst outcome
    // available here: the user sees a green run and no post. Refusing means the
    // gap is loud, in the run's own history, instead of silent.
    if (steps.length === 0) {
      await step.run("finish-empty-run", async () => {
        await recordEvent(runId, {
          level: "error",
          event: "run.no_steps",
          detail: {
            explanation:
              "No plan has been generated for this goal yet. This is expected until AI planning ships (Phase 5).",
          },
        });
        await transitionRun(runId, { type: "fail" });
      });

      return { runId, outcome: "no_plan" as const };
    }

    let anyFailed = false;
    let retryableFailure = false;

    for (const stepRow of steps) {
      if (isTerminal(stepRow.state as ExecutionState)) continue;

      const outcome = await step.run(`step-${stepRow.stepIndex}`, async () => {
        const execution = await executeStep(
          {
            id: stepRow.id,
            capability: stepRow.capability,
            targetAccount: stepRow.targetAccount,
            input: stepRow.input,
            idempotencyKey: stepRow.idempotencyKey,
          },
          event.data.userId,
          deps,
        );

        await settleStep(runId, stepRow.id, {
          state: execution.state,
          result: execution.result,
          error: execution.error,
        });

        return execution;
      });

      if (outcome.state !== "completed") {
        anyFailed = true;
        if (outcome.shouldRetry) retryableFailure = true;
      }
    }

    // --- 4. settle the run -----------------------------------------------
    await step.run("finish-run", async () => {
      if (!anyFailed) {
        await transitionRun(runId, { type: "succeed" });
        return;
      }

      await recordEvent(runId, {
        level: "error",
        event: "run.step_failed",
        detail: { retryable: retryableFailure },
      });
      await transitionRun(runId, { type: "fail" });
    });

    if (retryableFailure && attempt < MAX_ATTEMPTS) {
      // Ask the queue for another attempt. A new run is created for the retry
      // slot rather than reviving this one, which keeps `attempt` monotonic.
      await inngest.send({
        name: "hilbras/studio/goal-scheduled",
        data: { goalId, userId: event.data.userId, scheduleSlot, attempt: attempt + 1 },
      });
      await recordEvent(runId, {
        level: "warn",
        event: "run.retry_scheduled",
        detail: { nextAttempt: attempt + 1 },
      });
    }

    return {
      runId,
      outcome: anyFailed ? ("failed" as const) : ("completed" as const),
    };
  },
);

/**
 * The scheduler tick.
 *
 * Finds every goal whose firing time has arrived and sends one event per goal.
 * `dispatchDueGoals` decides the policy — which slots are due, how missed
 * firings collapse, what happens when a schedule stops parsing — and this
 * function is only the thing that owns a queue connection.
 */
export const dispatchDueGoals = inngest.createFunction(
  {
    id: "dispatch-due-goals",
    // A tick that throws is retried by Inngest, which is what we want: the
    // advance-then-dispatch order means a retry re-sends nothing, because the
    // goals that succeeded are no longer due.
    retries: 2,
    triggers: [{ cron: SCHEDULER_TICK }],
  },
  async () => {
    const summary = await dispatchDueGoalsImpl(async (event) => {
      // `inngest.send` resolves to the queue's ids, which the scheduler has no
      // use for — the dispatch result is what gets reported.
      await inngest.send({ name: GOAL_SCHEDULED, data: event });
    });

    return {
      due: summary.due,
      dispatched: summary.dispatched,
      skipped: summary.skipped,
      skippedGoals: summary.results
        .filter((result) => !result.dispatched)
        .map((result) => ({
          goalId: result.goalId,
          scheduleSlot: result.scheduleSlot,
          reason: result.reason,
        })),
    };
  },
);

export const inngestFunctions = [executeGoalRun, dispatchDueGoals];

// Re-exported so callers get the right error class from one module.
export { NonRetriableError };
