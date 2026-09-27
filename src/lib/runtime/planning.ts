/**
 * Planning — the step between "a goal fired" and "the Runtime has something to do".
 *
 * This is what Phase 4 could not ship: nothing had ever written a `run_steps`
 * row, so a goal would fire, execute nothing, and report success. The planner
 * closes that, and it is the first place in the system where a model's output is
 * about to cause something to happen in the world.
 *
 * ## The order of the four checks
 *
 * 1. **Can this goal be planned at all?** Every target account must be
 *    connected, enabled, and able to receive a delivery. Checked *before* the
 *    model is called, because a planner cannot fix a disconnected account, and
 *    asking it to would spend a call to be told the same thing back.
 * 2. **The model proposes.** Injected, so the whole function is testable with
 *    no provider.
 * 3. **The gate decides.** `validatePlan`, with the goal's targets as both the
 *    allowed set and the required set. The output is untrusted by construction,
 *    and the account list it is checked against is the goal's, not the user's.
 * 4. **The plan is written, in one transaction.** `runs.plan` and every
 *    `run_steps` row, or neither.
 *
 * ## One repair, and only before anything has run
 *
 * A refused plan is offered back once with the issues in the prompt. Two calls
 * total: a planner that cannot produce a valid plan after being told exactly
 * what is wrong with it will not produce one after being told twice, and each
 * attempt is a full prompt.
 *
 * Nothing here re-plans after a step has run. See `src/lib/ai/planner.ts` for
 * the longer argument; the short version is that a planner shown a failure is
 * being invited to remove the thing that failed, and the thing that failed is
 * the reason the run exists.
 *
 * ## State transitions are not this module's job
 *
 * `planRun` records its own events and returns a result. Deciding what the run
 * *becomes* belongs to the queue function, which owns the run lifecycle — one
 * place that can move a run from pending to running to a terminal state.
 */

import "server-only";

import { classifyAiError } from "@/lib/ai/complete";
import {
  toPlannerAccount,
  type PlannerContext,
} from "@/lib/ai/context";
import { DEFAULT_SPEND_LIMITS, type SpendLimits } from "@/lib/ai/limits";
import { proposePlan, repairNotesFor, type Completer } from "@/lib/ai/planner";
import { resolveAccounts, type ResolvedAccount } from "@/lib/accounts/store";
import { getGoal, listFiringHistory } from "@/lib/goals/service";

import {
  validatePlan,
  type PlanIssue,
  type PlanSpec,
  type RuntimeAccount,
} from "./plan";
import { getRun, persistPlan, recordEvent } from "./service";
import { deliveryCapability } from "./tools";

export type PlanRunFailureCode =
  | "run_not_found"
  | "goal_not_found"
  | "no_usable_target"
  | "ai_unavailable"
  | "unreadable_reply"
  | "plan_rejected";

export type PlanRunResult =
  | {
      ok: true;
      stepCount: number;
      /** Model calls spent, including any repair. */
      attempts: number;
      /** Whether the accepted plan repaired a refused first attempt. */
      repaired: boolean;
    }
  | {
      ok: false;
      code: PlanRunFailureCode;
      /** One line for the run event. Never thrown. */
      message: string;
      /** What the gate said, when it was the gate. */
      issues?: PlanIssue[];
      /**
       * Whether the queue should send another attempt for this slot.
       *
       * True only for a model call that failed in transit. A rejected plan and
       * an unreadable reply are both `false` even though they are not
       * certainly permanent: the plan is regenerated for the next firing
       * anyway, so another attempt inside this slot would spend calls to
       * produce a second copy of the same refusal.
       */
      retryable: boolean;
    };

export interface PlanRunDeps {
  /**
   * The model call. Injected so this function is testable with no provider, and
   * so the caller can decide what one costs — see `createCompleter`, which
   * charges the run's meter and the user's window budget inside the call.
   */
  complete: Completer;
  limits?: SpendLimits;
}

/** The failure half of `PlanRunResult`, named so narrowing reads. */
type PlanRunFailure = Extract<PlanRunResult, { ok: false }>;

const unableToPlan = (
  code: PlanRunFailureCode,
  message: string,
  retryable = false,
): PlanRunFailure => ({ ok: false, code, message, retryable });

/**
 * Why a target account cannot receive a delivery.
 *
 * Named per account rather than as one generic "invalid target", because these
 * send the user to three different places — reconnect it, switch it on, or
 * change the goal — and a message reading "an account is not usable" sends them
 * to none of them.
 */
function describeUnusableTarget(
  accountKey: string,
  resolved: ResolvedAccount | undefined,
): string | null {
  if (!resolved) return `"${accountKey}" is not connected.`;
  if (!resolved.enabled) return `"${accountKey}" is switched off.`;

  const capability = deliveryCapability();
  if (capability && !resolved.capabilities.includes(capability)) {
    return `"${accountKey}" cannot ${capability.replace(/_/g, " ")}.`;
  }
  return null;
}

/** The account list the gate checks against: the goal's targets, and only those. */
function asRuntimeAccounts(targets: ResolvedAccount[]): RuntimeAccount[] {
  return targets.map((account) => ({
    id: account.accountKey,
    platform: account.platform,
    enabled: account.enabled,
  }));
}

async function buildContext(
  goalId: string,
  runId: string,
  targets: ResolvedAccount[],
  base: Pick<PlannerContext, "goalTitle" | "statement">,
): Promise<PlannerContext> {
  return {
    ...base,
    accounts: targets.map((account) =>
      toPlannerAccount({
        id: account.accountKey,
        platform: account.platform,
        handle: account.handle,
      }),
    ),
    history: await listFiringHistory(goalId, { limit: 5, excludeRunId: runId }),
    repairNotes: [],
  };
}

/** The shape `persistPlan` wants, with the fields a step actually uses. */
function toStepRows(plan: PlanSpec) {
  return plan.steps.map((step, stepIndex) => ({
    stepIndex,
    label: step.label,
    capability: step.capability,
    targetAccount: step.targetAccount ?? null,
    input: step.input,
  }));
}

/**
 * Plan one run, or explain why it could not be planned.
 *
 * Never throws for an expected failure — a missing provider, an unreadable
 * reply, a plan the gate refused. Each becomes an event on the run and a
 * returned result, because a planning failure that crashed the function would be
 * retried by the queue with nothing recorded about what the model said, which is
 * the one thing worth having when a goal stops working.
 */
export async function planRun(
  runId: string,
  deps: PlanRunDeps,
): Promise<PlanRunResult> {
  const limits = deps.limits ?? DEFAULT_SPEND_LIMITS;

  const run = await getRun(runId);
  if (!run) {
    return unableToPlan("run_not_found", `Run ${runId} does not exist.`);
  }

  const goal = await getGoal(run.userId, run.goalId);
  if (!goal) {
    return unableToPlan(
      "goal_not_found",
      `Goal ${run.goalId} no longer exists, so there is nothing to plan.`,
    );
  }

  // --- 1. can this be planned at all? --------------------------------------
  const resolved = new Map(
    (await resolveAccounts(run.userId, goal.targetAccounts)).map((account) => [
      account.accountKey,
      account,
    ]),
  );

  const unusable = goal.targetAccounts
    .map((key) => describeUnusableTarget(key, resolved.get(key)))
    .filter((reason): reason is string => reason !== null);

  if (unusable.length > 0) {
    const message =
      `This goal cannot be planned: ${unusable.join("; ")}. ` +
      "Reconnect or switch the account on, or change the goal's targets.";
    await recordEvent(runId, {
      level: "error",
      event: "plan.no_usable_target",
      detail: { unusable },
    });
    return unableToPlan("no_usable_target", message);
  }

  // `validateGoal` refuses a goal with no targets, so this is unreachable
  // through the service. It is checked anyway because the alternative is a plan
  // generated against an empty account list, and `requiredTargets: []` makes
  // the coverage check vacuously true — a run that plans successfully and has
  // nothing to do.
  if (goal.targetAccounts.length === 0) {
    const message = "This goal has no target accounts, so there is nothing to plan.";
    await recordEvent(runId, {
      level: "error",
      event: "plan.no_usable_target",
      detail: { unusable: [] },
    });
    return unableToPlan("no_usable_target", message);
  }

  // --- 2–3. propose, gate, repair once -------------------------------------
  const targets = goal.targetAccounts
    .map((key) => resolved.get(key))
    .filter((account): account is ResolvedAccount => account !== undefined);

  const runtimeAccounts = asRuntimeAccounts(targets);
  const capabilitiesFor = (account: RuntimeAccount) =>
    targets.find((candidate) => candidate.accountKey === account.id)?.capabilities ?? [];

  const context = await buildContext(goal.id, runId, targets, {
    goalTitle: goal.title,
    statement: goal.statement,
  });

  let attempts = 0;
  let refusal: PlanRunFailure | null = null;
  let lastIssueCount = 0;

  for (let attempt = 0; attempt < limits.perPlan; attempt += 1) {
    let proposed;
    try {
      proposed = await proposePlan(context, deps.complete);
    } catch (cause) {
      // The model did not answer. Recorded and returned rather than repaired
      // around: asking the same provider again inside the same attempt would
      // fail the same way, and whether the queue retries is the executor's
      // decision, not the planner's.
      const error = classifyAiError(cause);
      await recordEvent(runId, {
        level: "error",
        event: "plan.ai_unavailable",
        detail: { code: error.code, message: error.message, attempts: attempts + 1 },
      });
      return unableToPlan(
        "ai_unavailable",
        `The model could not plan this run: ${error.message}`,
        error.retryable,
      );
    }

    attempts += 1;

    if (!proposed.ok) {
      // An unreadable reply is repairable in the same way a rejected plan is —
      // the model is told what it did wrong. What it is *not* is a reason for
      // the queue to try this slot again: the repair already happened, and a
      // second failure of the same shape would be reported identically.
      refusal = unableToPlan("unreadable_reply", proposed.reason);
      context.repairNotes = [proposed.reason];
      continue;
    }

    const validation = validatePlan({
      plan: proposed.plan,
      accounts: runtimeAccounts,
      capabilitiesFor,
      requiredTargets: goal.targetAccounts,
    });

    if (!validation.ok) {
      lastIssueCount = validation.issues.length;
      await recordEvent(runId, {
        level: "warn",
        event: "plan.rejected",
        detail: { issues: validation.issues, attempt: attempt + 1 },
      });
      refusal = {
        ok: false,
        code: "plan_rejected",
        message: validation.issues[0]?.message ?? "The plan was refused by validation.",
        issues: validation.issues,
        retryable: false,
      };
      context.repairNotes = repairNotesFor(validation.issues);
      continue;
    }

    // --- 4. write it -------------------------------------------------------
    const written = await persistPlan(runId, proposed.plan, toStepRows(proposed.plan));

    await recordEvent(runId, {
      level: attempt === 0 ? "info" : "warn",
      event: attempt === 0 ? "plan.created" : "plan.repaired",
      detail: {
        steps: written.stepCount,
        attempts,
        ...(attempt === 0 ? {} : { repairedIssues: lastIssueCount }),
      },
    });

    return {
      ok: true,
      stepCount: written.stepCount,
      attempts,
      repaired: attempt > 0,
    };
  }

  const failure: PlanRunFailure =
    refusal ?? unableToPlan("plan_rejected", "The plan was refused by validation.");
  await recordEvent(runId, {
    level: "error",
    event: `plan.${failure.code}`,
    detail: { message: failure.message, attempts },
  });
  return failure;
}
