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
 *   3. plan  — the AI turns the goal's statement into steps (Phase 5)
 *   4. execute each step through its tool
 *   5. settle the run from the step outcomes
 *
 * A step that fails does not abort the others. A goal that publishes to two
 * accounts should publish to the one that still works, and report the one that
 * did not — the same "settle each target independently" rule the v0.1.0
 * composer already follows. A step whose *inputs* never arrived is the
 * exception, and the executor refuses it rather than running it with nothing.
 */

import { NonRetriableError } from "inngest";

import { createCompleter } from "@/lib/ai/complete";
import { createSpendMeter, DEFAULT_SPEND_LIMITS } from "@/lib/ai/limits";
import { dispatchDueGoals as dispatchDueGoalsImpl } from "@/lib/goals/scheduler";

import { executeStep, resolverForUser, type ExecutorDeps } from "../executor";
import { createLocalToolRunner } from "../local-tools";
import { planRun } from "../planning";
import {
  createRun,
  listRunSteps,
  recordEvent,
  settleStep,
  transitionRun,
} from "../service";
import { isTerminal, type ExecutionState } from "../state";
import { parseToolResult, type ToolResult } from "../tools";

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
    const userId = event.data.userId;

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

    // --- 2. start ---------------------------------------------------------
    const started = await step.run("start-run", () =>
      transitionRun(runId, { type: "start" }),
    );
    if (started === null) {
      return { runId, outcome: "not_startable" as const };
    }

    // One ceiling for the whole attempt: the planner and every `compose_post`
    // charge the same meter, so a plan cannot be repaired ten times and then
    // compose ten times.
    //
    // It is a ceiling, not a ledger — a redelivery rebuilds it, so the bound
    // that actually holds across attempts is `MAX_ATTEMPTS * perRun`. That is
    // recorded in `docs/ai/context.md` rather than papered over with a write to
    // the hot path; making it exact is a Phase 8 concern, when retry policy is
    // rebuilt anyway.
    const spend = createSpendMeter(DEFAULT_SPEND_LIMITS);

    // --- 3. plan ----------------------------------------------------------
    // Inside a `step` for the same reason as the claim: a crash after planning
    // replays the memo, so the plan is generated once per run even though the
    // function body can run more than once.
    const plan = await step.run("plan-run", () =>
      planRun(runId, {
        limits: DEFAULT_SPEND_LIMITS,
        complete: createCompleter({
          userId,
          kind: "planner",
          authorize: () => spend.takePlan(),
        }),
      }),
    );

    if (!plan.ok) {
      await step.run("finish-unplanned-run", () =>
        transitionRun(runId, { type: "fail" }),
      );

      // Only a model call that failed in transit is worth another attempt, and
      // `planRun` has already recorded why. A refused plan is not retried: the
      // next firing generates a fresh one from a fresh attempt.
      if (plan.retryable && attempt < MAX_ATTEMPTS) {
        await sendAnotherAttempt({ goalId, userId, scheduleSlot, attempt, runId });
      }

      return { runId, outcome: "no_plan" as const, reason: plan.code };
    }

    // --- 4. execute the steps --------------------------------------------
    // Resolve connectors through the accounts table, not the account key's
    // prefix. The queue owns the user for this run, so the resolver is built
    // once here rather than per step — and, unlike the registry-only default,
    // it refuses a disabled or unknown account instead of publishing anyway.
    const deps: Omit<ExecutorDeps, "priorResults"> = {
      resolveConnector: resolverForUser(userId),
      runLocalTool: createLocalToolRunner({
        spend,
        limits: DEFAULT_SPEND_LIMITS,
      }),
    };

    const steps = await step.run("load-steps", () => listRunSteps(runId));

    // A run with no steps is still not a successful no-op.
    //
    // The planner is what writes `run_steps`, so this should now be
    // unreachable — `planRun` refuses to persist an empty plan, and the
    // `no_plan` branch above returns first. It stays as the backstop it was in
    // v0.6.0: a run that somehow reached execution with nothing to do reports a
    // failure rather than a success, and the backstop costs one comparison.
    if (steps.length === 0) {
      await step.run("finish-empty-run", async () => {
        await recordEvent(runId, {
          level: "error",
          event: "run.no_steps",
          detail: {
            explanation:
              "The run reached execution with no steps. The planner should have refused to persist an empty plan, so this is a defect rather than a known limitation.",
          },
        });
        await transitionRun(runId, { type: "fail" });
      });

      return { runId, outcome: "no_plan" as const, reason: "no_steps" as const };
    }

    // Results of the steps that have already run, so a `$ref` resolves from what
    // actually happened. Rebuilt from the persisted rows for steps this attempt
    // skipped, and from the loop's own outcomes for the rest.
    const priorResults = new Map<number, ToolResult>();
    for (const row of steps) {
      if (row.state !== "completed") continue;
      const result = parseToolResult(row.result);
      if (result) priorResults.set(row.stepIndex, result);
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
          userId,
          { ...deps, priorResults },
        );

        await settleStep(runId, stepRow.id, {
          state: execution.state,
          result: execution.result,
          error: execution.error,
        });

        return execution;
      });

      // Outside the `step` on purpose: on a replay the memo is returned without
      // running the closure, and the map still has to be filled from it or every
      // later `$ref` would resolve against nothing.
      if (outcome.state === "completed" && outcome.result) {
        priorResults.set(stepRow.stepIndex, outcome.result);
      }

      if (outcome.state !== "completed") {
        anyFailed = true;
        if (outcome.shouldRetry) retryableFailure = true;
      }
    }

    // --- 5. settle the run -----------------------------------------------
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
      await sendAnotherAttempt({ goalId, userId, scheduleSlot, attempt, runId });
    }

    return {
      runId,
      outcome: anyFailed ? ("failed" as const) : ("completed" as const),
    };
  },
);

/**
 * Ask the queue for another attempt at this slot.
 *
 * A new run is created for the retry slot rather than reviving the failed one,
 * which keeps `attempt` monotonic and leaves history an append-only record. A
 * retry also re-plans — the model may have failed transiently, and a plan
 * generated from a second attempt is a fresh plan, not a replay of a bad one.
 */
async function sendAnotherAttempt(input: {
  goalId: string;
  userId: string;
  scheduleSlot: string;
  attempt: number;
  runId: string;
}): Promise<void> {
  await inngest.send({
    name: GOAL_SCHEDULED,
    data: {
      goalId: input.goalId,
      userId: input.userId,
      scheduleSlot: input.scheduleSlot,
      attempt: input.attempt + 1,
    },
  });
  await recordEvent(input.runId, {
    level: "warn",
    event: "run.retry_scheduled",
    detail: { nextAttempt: input.attempt + 1 },
  });
}

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
