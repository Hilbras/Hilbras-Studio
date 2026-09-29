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
 *
 * ## Suspension, and why it is a return and not a throw
 *
 * v0.8.0 added a third ending. A step whose policy requires consent ends in
 * `awaiting_approval`; the run transitions to `awaiting_approval` and the
 * function **returns normally**. It does not throw `NonRetriableError`, and it
 * does not ask the queue for another attempt, because another attempt would
 * arrive at the same question and asking twice is not a way of asking better.
 *
 * A suspension is not a failure and it is not work in progress. It is the
 * function completing: it has done everything it can, and the run now lives in
 * Postgres rather than in the queue. Resumption is a *new* invocation, from
 * `APPROVAL_DECIDED`.
 *
 * ## Why a separate function for the resume
 *
 * `executeGoalRun` claims a fresh schedule slot, and `createRun` is idempotent
 * on that slot — so a resume arriving as another `GOAL_SCHEDULED` would be
 * absorbed and never continue. Rather than weaken the claim, the resume gets its
 * own function and its own trigger, and both call `advanceRun`, which is where
 * the shared work lives. The claim is what makes at-least-once safe (ADR-005);
 * carving an exception into it for resumption would give that up for a
 * convenience.
 */

import { NonRetriableError, type GetStepTools } from "inngest";

import { createCompleter } from "@/lib/ai/complete";
import { createSpendMeter, DEFAULT_SPEND_LIMITS } from "@/lib/ai/limits";
import { dispatchDueGoals as dispatchDueGoalsImpl } from "@/lib/goals/scheduler";

import { approvalExpiredError, approvalRejectedError } from "../approvals";
import {
  createApprovalGate,
  expireOverdueApprovals,
  getStepApproval,
  getStepApprovalById,
  listApprovalsNeedingResume,
} from "../approval-store";
import {
  executeStep,
  resolverForUser,
  type ExecutableStep,
  type ExecutorDeps,
  type StepExecution,
} from "../executor";
import { createLocalToolRunner } from "../local-tools";
import { planRun } from "../planning";
import {
  claimStep,
  createRun,
  getRun,
  listRunSteps,
  recordEvent,
  releaseStepClaim,
  settleStep,
  suspendStep,
  transitionRun,
} from "../service";
import { isTerminal, type ExecutionState } from "../state";
import { parseToolResult, type ToolResult } from "../tools";

import { APPROVAL_DECIDED, GOAL_SCHEDULED, inngest } from "./client";

/**
 * The `step` handle every Inngest function receives.
 *
 * Named once because `advanceRun` and `resumeDecision` are plain async functions
 * called from inside two different handlers, and a helper cannot be typed with
 * the handler's own parameter. `GetStepTools` is the SDK's own extraction of that
 * type, so it tracks the installed version rather than restating it.
 */
type StepTools = GetStepTools<typeof inngest>;

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

/** How a run ended, or how it is waiting. */
type RunOutcome =
  | "completed"
  | "failed"
  | "no_plan"
  /** Waiting for a person. Not a failure, and not a retry. */
  | "awaiting_approval"
  /** The run was already finished before this invocation looked at it. */
  | "already_finished";

interface AdvanceResult {
  runId: string;
  outcome: RunOutcome;
  reason?: string;
  /**
   * Whether the caller should ask for another attempt at this slot.
   *
   * Reported rather than sent, because the retry needs the attempt and the
   * schedule slot and a resume has neither — a resumed run is the same attempt,
   * continuing. A retryable failure on a resume is therefore *not* retried here;
   * the next scheduled firing is the next chance, which is the same rule that
   * keeps a second attempt from re-publishing a post that already went out.
   */
  retryable: boolean;
}

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
      return { runId, outcome: "already_finished" as const };
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
        transitionRun(runId, { type: "fail", summary: plan.message }),
      );

      // Only a model call that failed in transit is worth another attempt, and
      // `planRun` has already recorded why. A refused plan is not retried: the
      // next firing generates a fresh one from a fresh attempt.
      if (plan.retryable && attempt < MAX_ATTEMPTS) {
        await sendAnotherAttempt({ goalId, userId, scheduleSlot, attempt, runId });
      }

      return { runId, outcome: "no_plan" as const, reason: plan.code };
    }

    // --- 4 & 5. execute and settle ---------------------------------------
    const result = await advanceRun({ runId, userId, step, spend });

    if (result.retryable && attempt < MAX_ATTEMPTS) {
      await sendAnotherAttempt({ goalId, userId, scheduleSlot, attempt, runId });
    }

    return { runId: result.runId, outcome: result.outcome, reason: result.reason };
  },
);

/**
 * Continue a run that is already planned and already started.
 *
 * Shared by the two functions that can reach a run mid-execution:
 *
 * - `execute-goal-run`, immediately after planning.
 * - `resume-goal-run`, when an approval is answered or expires.
 *
 * `planning` is the only step skipped on a resume, and it has to be skipped
 * rather than repeated: `planRun` charges a model call before it discovers the
 * plan already exists, so calling it on a resume would spend a call to be told
 * about the plan this run already has. `persistPlan` refusing a second write is
 * what makes the *outcome* safe; this is what makes it not wasteful.
 *
 * The budget is a ceiling per invocation, and a resume is a separate invocation
 * — so a run that composes, suspends, resumes, and composes again gets a fresh
 * allowance rather than one shared across a day. That is the honest accounting
 * for an at-least-once queue with no cross-invocation ledger, and the same
 * bound `docs/ai/context.md` already documents for redeliveries.
 */
async function advanceRun(input: {
  runId: string;
  userId: string;
  step: StepTools;
  spend: ReturnType<typeof createSpendMeter>;
}): Promise<AdvanceResult> {
  const { runId, userId, step: stepHandle, spend } = input;

  // Resolve connectors through the accounts table, not the account key's
  // prefix. The queue owns the user for this run, so the resolver is built
  // once here rather than per step — and, unlike the registry-only default,
  // it refuses a disabled or unknown account instead of publishing anyway.
  //
  // The permission gate is built here too, for the same reason: one policy read
  // per run rather than per step.
  const deps: Omit<ExecutorDeps, "priorResults"> = {
    resolveConnector: resolverForUser(userId),
    approval: createApprovalGate(userId),
    runLocalTool: createLocalToolRunner({
      spend,
      limits: DEFAULT_SPEND_LIMITS,
    }),
  };

  const steps = await stepHandle.run("load-steps", () => listRunSteps(runId));

  // A run with no steps is still not a successful no-op.
  //
  // The planner is what writes `run_steps`, so this should now be
  // unreachable — `planRun` refuses to persist an empty plan, and the
  // `no_plan` branch above returns first. It stays as the backstop it was in
  // v0.6.0: a run that somehow reached execution with nothing to do reports a
  // failure rather than a success, and the backstop costs one comparison.
  if (steps.length === 0) {
    const explanation =
      "The run reached execution with no steps. The planner should have refused to persist an empty plan, so this is a defect rather than a known limitation.";

    await stepHandle.run("finish-empty-run", async () => {
      await recordEvent(runId, {
        level: "error",
        event: "run.no_steps",
        detail: { explanation },
      });
      await transitionRun(runId, { type: "fail", summary: explanation });
    });

    return { runId, outcome: "no_plan", reason: "no_steps", retryable: false };
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
  /** The first step failure's message, which becomes the run's `errorSummary`. */
  let firstFailure: string | undefined;

  for (const stepRow of steps as StepRow[]) {
    if (isTerminal(stepRow.state as ExecutionState)) continue;

    // A step that was suspended and has since been answered resumes here. The
    // answer — including any edit — is read rather than carried, because a
    // decision can be made days after the invocation that asked, and the only
    // durable copy of it is the row.
    if (stepRow.state === "awaiting_approval") {
      const handled = await stepHandle.run(
        `approval-${stepRow.stepIndex}`,
        () => resumeDecision({ runId, userId, stepHandle, stepRow, deps, priorResults }),
      );

      if (handled.kind === "suspended") {
        // Still unanswered. The run is already in `awaiting_approval`; there is
        // nothing to do but stop.
        return { runId, outcome: "awaiting_approval", retryable: false };
      }
      if (handled.kind === "settled") {
        anyFailed = true;
        continue;
      }
      // `executed` — fall through to the settle at the bottom of the loop.
      if (handled.execution.state === "completed" && handled.execution.result) {
        priorResults.set(stepRow.stepIndex, handled.execution.result);
      }
      if (handled.execution.state !== "completed") anyFailed = true;
      continue;
    }

    const claimed = await stepHandle.run(`claim-step-${stepRow.stepIndex}`, () =>
      claimStep(stepRow.id, stepRow.state as ExecutionState),
    );
    if (!claimed) {
      // Another invocation holds it, or it held it recently enough that the
      // lease has not expired. Its own `step.run` will settle the row, so this
      // pass must not settle it too, and must not act on a step it did not
      // claim. See `STEP_CLAIM_LEASE_MS` for what "recently enough" means.
      continue;
    }

    const outcome = await stepHandle.run(
      `step-${stepRow.stepIndex}`,
      async () => {
        const execution = await executeClaimed({
          runId,
          userId,
          step: {
            id: stepRow.id,
            runId,
            capability: stepRow.capability,
            targetAccount: stepRow.targetAccount,
            input: stepRow.input,
            idempotencyKey: stepRow.idempotencyKey,
          },
          from: stepRow.state as ExecutionState,
          deps,
          priorResults,
        });

        if (execution.state === "awaiting_approval") {
          // The gate has already written the question; this records the step's
          // half of the same fact. Two writes rather than a transaction, and
          // that is safe because both happen inside one `step.run` closure: a
          // replay re-runs the closure, `requestApproval` is idempotent on the
          // step, and the existing question keeps its original deadline.
          await suspendStep(runId, stepRow.id, execution.approval);
        } else {
          await settleStep(runId, stepRow.id, {
            state: execution.state,
            result: execution.result,
            error: execution.error,
          });
        }

        return execution;
      },
    );

    // Outside the `step` on purpose: on a replay the memo is returned without
    // running the closure, and the map still has to be filled from it or every
    // later `$ref` would resolve against nothing.
    if (outcome.state === "completed" && outcome.result) {
      priorResults.set(stepRow.stepIndex, outcome.result);
    }

    if (outcome.state === "awaiting_approval") {
      // The run is suspended, not finished. No settlement, no retry: another
      // attempt would arrive at the same question.
      await stepHandle.run("suspend-run", async () => {
        await recordEvent(runId, {
          stepId: stepRow.id,
          level: "info",
          event: "run.awaiting_approval",
          detail: {
            approvalId: outcome.approval?.id,
            // `String`, not `toISOString`: the memo hands this back as a string
            // after a crash, and the two closures have to agree on what they are
            // writing. The event is a record, so the string is the whole truth.
            expiresAt: outcome.approval ? String(outcome.approval.expiresAt) : null,
          },
        });
        await transitionRun(runId, { type: "request_approval" });
      });

      return { runId, outcome: "awaiting_approval", retryable: false };
    }

    if (outcome.state !== "completed") {
      anyFailed = true;
      if (outcome.shouldRetry) retryableFailure = true;
      // The first failure is the summary. A run whose third step failed because
      // Instagram was rate-limiting is *about* Instagram, and listing all three
      // reasons would bury the one a user needs in order to act.
      if (outcome.state === "failed" && !firstFailure) {
        firstFailure = outcome.error.message;
      }
    }
  }

  // --- settle the run ----------------------------------------------------
  await stepHandle.run("finish-run", async () => {
    if (!anyFailed) {
      await transitionRun(runId, { type: "succeed" });
      return;
    }

    await recordEvent(runId, {
      level: "error",
      event: "run.step_failed",
      detail: { retryable: retryableFailure },
    });
    await transitionRun(runId, { type: "fail", summary: firstFailure });
  });

  return {
    runId,
    outcome: anyFailed ? "failed" : "completed",
    retryable: retryableFailure,
  };
}

/**
 * The parts of a persisted step this loop reads.
 *
 * Narrower than the row, and narrower than what the memo gives back, on purpose.
 * Inngest persists a `step.run` result as JSON, so a `Date` comes back as a
 * string — which the previous, looser typing hid. The loop only needs these
 * seven fields, none of which is a date, so declaring exactly them is both the
 * truth and the type that survives a replay. A step's timestamps are read through
 * the database, not through the memo.
 */
type StepRow = Pick<
  Awaited<ReturnType<typeof listRunSteps>>[number],
  | "id"
  | "runId"
  | "stepIndex"
  | "capability"
  | "targetAccount"
  | "state"
  | "input"
  | "idempotencyKey"
> & { result: string | null };

/**
 * Execute a step whose claim we hold, and never leave the claim behind.
 *
 * `executeStep` turns every outcome it can reach into a value, so the only ways
 * it throws are a defect here or a database failure while asking the permission
 * gate. A claim is a *reservation*, and a reserved step nobody finishes is
 * `running` forever — in-progress to the lease logic, settled by nobody.
 *
 * So the claim is handed back to the state the step was in and the throw
 * continues. Returning it to the *original* state rather than to `failed` is what
 * makes the queue's retry a clean second look: had the step been left failed,
 * the retry would skip it as terminal and the run would report success having
 * published nothing.
 */
async function executeClaimed(input: {
  runId: string;
  userId: string;
  step: ExecutableStep;
  /** The state to restore the claim to if execution cannot even be attempted. */
  from: ExecutionState;
  deps: Omit<ExecutorDeps, "priorResults">;
  priorResults: Map<number, ToolResult>;
}): Promise<StepExecution> {
  try {
    return await executeStep(input.step, input.userId, {
      ...input.deps,
      priorResults: input.priorResults,
    });
  } catch (cause) {
    await releaseStepClaim(input.runId, input.step.id, input.from, {
      message: cause instanceof Error ? cause.message : String(cause),
      explanation:
        "Execution could not be attempted, so the step's claim was released. The queue's retry is the answer, not a settled failure: a step marked failed here would be skipped as terminal and the run would report success having published nothing.",
    });
    throw cause;
  }
}

/**
 * Settle one suspended step according to the answer on its approval row.
 *
 * Three answers, and none of them is "resume the step":
 *
 * - **approved** — claim the step and execute it with the input the person saw
 *   and possibly edited, not with the `$ref` the plan stored. What was approved
 *   is what publishes, and that is only true if the same values are used.
 * - **rejected** — the step fails. The run continues, so a goal pointed at two
 *   accounts still reaches the one nobody objected to.
 * - **expired** — also a failure, and a step cannot be executed for a step that
 *   is no longer in `awaiting_approval`, so the claim is skipped.
 *
 * A step that is still `pending` — the resume arrived before the decision
 * committed, which a re-sent event makes possible — leaves the run suspended.
 * The question is not answered, and the honest thing is to wait for the answer
 * rather than to proceed without it.
 */
async function resumeDecision(input: {
  runId: string;
  userId: string;
  stepHandle: StepTools;
  stepRow: StepRow;
  deps: Omit<ExecutorDeps, "priorResults">;
  priorResults: Map<number, ToolResult>;
}): Promise<
  | { kind: "suspended" }
  | { kind: "settled" }
  | { kind: "executed"; execution: Awaited<ReturnType<typeof executeStep>> }
> {
  const { runId, userId, stepHandle, stepRow, deps, priorResults } = input;

  const approval = await getStepApproval(stepRow.id);

  // A step that is still `pending` has not been answered. The resume may have
  // arrived before the decision committed — a re-sent event makes that ordinary —
  // and the honest thing is to wait for the answer rather than proceed without
  // it. The same holds for a step with no approval row at all: nothing said yes.
  if (!approval || approval.state === "pending") return { kind: "suspended" };

  // The run is `awaiting_approval` because of this step, and the wait is over.
  // Every decision resumes the run — see the note in `../state`.
  const event =
    approval.state === "approved"
      ? ("approve" as const)
      : approval.state === "rejected"
        ? ("reject" as const)
        : ("approval_timeout" as const);

  const resumed = await stepHandle.run("resume-run", () =>
    transitionRun(runId, { type: event }),
  );
  if (resumed === null) {
    // Someone stopped the run while it waited, or another invocation already
    // resumed it. Both are legitimate; neither should be overwritten.
    return { kind: "settled" };
  }

  if (approval.state !== "approved") {
    await settleStep(runId, stepRow.id, {
      state: "failed",
      error:
        approval.state === "rejected"
          ? approvalRejectedError(approval.targetAccount)
          : approvalExpiredError(approval.targetAccount),
    });
    return { kind: "settled" };
  }

  const claimed = await stepHandle.run(`claim-step-${stepRow.stepIndex}`, () =>
    claimStep(stepRow.id, "awaiting_approval"),
  );
  if (!claimed) return { kind: "settled" };

  const execution = await stepHandle.run(
    `approved-step-${stepRow.stepIndex}`,
    async () => {
      const result = await executeClaimed({
        runId,
        userId,
        step: {
          id: stepRow.id,
          runId,
          capability: stepRow.capability,
          targetAccount: stepRow.targetAccount,
          // The approved input, verbatim. Serialised here because the executor
          // takes the step's stored JSON, and the approved values are the ones
          // the person agreed to — the `$ref` in the row would resolve to
          // whatever the compose step says, which may not be what was shown.
          input: JSON.stringify(approval.input),
          idempotencyKey: stepRow.idempotencyKey,
        },
        from: "awaiting_approval",
        deps,
        priorResults,
      });

      if (result.state === "awaiting_approval") {
        // The policy now demands a fresh approval, e.g. the user switched it
        // from `auto` to `approval` while this one was pending. `requestApproval`
        // is keyed on the step, so the existing row is returned and the step
        // goes back to waiting for it. Recorded, because "approved, then asked
        // again" is otherwise invisible.
        await recordEvent(runId, {
          stepId: stepRow.id,
          level: "warn",
          event: "approval.re_requested",
          detail: { approvalId: result.approval?.id },
        });
        await suspendStep(runId, stepRow.id, result.approval!);
        return result;
      }

      await settleStep(runId, stepRow.id, {
        state: result.state,
        result: result.result,
        error: result.error,
      });
      return result;
    },
  );

  if (execution.state === "awaiting_approval") {
    await stepHandle.run("suspend-run", () =>
      transitionRun(runId, { type: "request_approval" }),
    );
    return { kind: "suspended" };
  }

  return { kind: "executed", execution };
}

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

/**
 * Wake a run whose approval has been answered.
 *
 * A separate function from `execute-goal-run` because that one claims a schedule
 * slot, and `createRun` is idempotent on the slot — a resume arriving as another
 * `GOAL_SCHEDULED` would be absorbed and the run would sit in
 * `awaiting_approval` forever. The claim is what makes at-least-once safe
 * (ADR-005), so it stays intact and the resume gets its own trigger.
 *
 * Reads the run rather than trusting the event's contents: the event carries ids
 * because a queue message that could be read must not be able to say what a post
 * said or how it was answered.
 *
 * A run that is already finished, or is `running` because another resume got
 * there first, is left alone. The step-level claim is what actually prevents a
 * double publish; this is the cheap outer check that keeps the common case from
 * loading and walking every step.
 */
export const resumeGoalRun = inngest.createFunction(
  {
    id: "resume-goal-run",
    // A resume that throws is the same defect a normal attempt throwing is: the
    // claim is released, so a retry is a clean second look rather than a wait.
    retries: MAX_ATTEMPTS,
    triggers: [{ event: APPROVAL_DECIDED }],
  },
  async ({ event, step }) => {
    const { runId, approvalId } = event.data;

    const target = await step.run("read-resume-target", async () => {
      const row = await getRun(runId);
      // The approval's own state is the authority on whether there is anything to
      // do. The event naming an approval that is still pending is not an error —
      // it is the re-sent case — so it is checked here rather than thrown.
      const approval = await getStepApprovalById(approvalId);
      return { row, approvalState: approval?.state ?? null };
    });

    if (!target.row) {
      return { runId, outcome: "already_finished" as const };
    }
    if (isTerminal(target.row.state as ExecutionState)) {
      return { runId, outcome: "already_finished" as const };
    }
    if (target.approvalState === null || target.approvalState === "pending") {
      return { runId, outcome: "awaiting_approval" as const };
    }

    // A fresh budget for a fresh invocation. The meter is a ceiling, and a
    // resumed run is a new invocation — see `advanceRun`.
    const result = await advanceRun({
      runId,
      userId: target.row.userId,
      step,
      spend: createSpendMeter(DEFAULT_SPEND_LIMITS),
    });

    // `retryable` is deliberately ignored. A retry needs an attempt number and
    // a schedule slot, and a resume has neither — it is the same attempt,
    // continuing. The next scheduled firing is the next chance, which is also
    // what keeps a second attempt from re-publishing a post that already went
    // out while the person was deciding.
    return { runId: result.runId, outcome: result.outcome, reason: result.reason };
  },
);

/**
 * The approval sweeper.
 *
 * Two jobs, both of them things that must happen without a person present:
 *
 * 1. **Expire** approvals nobody answered. A deadline that only the reader
 *    enforces is not a deadline — a user can always answer one afterwards. So
 *    the window is closed by a write, and the write is what the resume path
 *    reacts to.
 * 2. **Resend** decisions that never reached the resume path. The queue is not
 *    transactional with Postgres, so a crash between "the person said yes" and
 *    "tell the queue" would otherwise leave a run suspended forever with an
 *    approved post beside it.
 *
 * The second job is what makes suspension *durable* rather than usually durable,
 * and it costs one query, because a decision is "picked up" exactly when the step
 * it was about stops being `awaiting_approval`. Once the resume runs, the row
 * leaves the set — so a suspended run is re-sent at most once per tick and only
 * while it is genuinely stuck, not on every tick forever.
 *
 * Its own function, on the same five-minute tick, so a sweep that throws is
 * retried without also re-running the goal dispatch.
 */
export const settleApprovals = inngest.createFunction(
  {
    id: "settle-approvals",
    retries: 2,
    triggers: [{ cron: SCHEDULER_TICK }],
  },
  async ({ step }) => {
    const expired = await step.run("expire-overdue", () =>
      expireOverdueApprovals(),
    );

    const stuck = await step.run("find-unresumed", () =>
      listApprovalsNeedingResume(),
    );

    // Idempotent by construction: the step-level claim stops a second resume from
    // dispatching anything the first one already dispatched, and a resume that
    // finds the step settled just walks past it.
    for (const approval of stuck) {
      await inngest.send({
        name: APPROVAL_DECIDED,
        data: { runId: approval.runId, approvalId: approval.id },
      });
    }

    return {
      expired: expired.length,
      resumed: stuck.length,
      expiredRuns: expired.map((approval) => approval.runId),
    };
  },
);

export const inngestFunctions = [
  executeGoalRun,
  resumeGoalRun,
  dispatchDueGoals,
  settleApprovals,
];

// Re-exported so callers get the right error class from one module.
export { NonRetriableError };
