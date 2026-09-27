/**
 * Model spend within a single run.
 *
 * ## Why this is not a rate limit
 *
 * `@/lib/ai-budget` already limits AI use per user and per deployment over a
 * five-minute window. That protects the *provider key* from traffic. It does
 * nothing for a different question: a run that plans, then composes once per
 * target, then composes again because the first answer was too long, and then
 * re-plans, and then does it all again on a retry — how many times is one
 * firing allowed to call the model?
 *
 * That is a per-run budget, and it has to be held in memory by the run itself.
 * Making it a rate limit would be wrong in a specific way: a rate limit is
 * keyed by user and window, so a run that spent its allowance would be
 * indistinguishable from a user who spent theirs, and the limit would leak
 * between two of the user's own concurrent goals.
 *
 * ## The three caps
 *
 * - **per plan** bounds the plan/repair loop. Two means: propose once, repair
 *   once. A planner that cannot produce a valid plan in two attempts is not
 *   going to produce one in five, and each attempt is a full prompt.
 * - **per step** bounds one step's own attempts. Two means: write the post
 *   once, ask again once if the answer broke a platform's character limit.
 * - **per run** is the ceiling the other two are measured against, so a plan
 *   with a hundred steps still cannot spend a hundred calls.
 *
 * The per-run cap is what makes the other two advisory rather than decorative.
 */

export interface SpendLimits {
  /** Model calls one planning attempt may consume, including repairs. */
  perPlan: number;
  /** Model calls one step's tool may consume. */
  perStep: number;
  /** Model calls one run may consume in total. */
  perRun: number;
}

/**
 * Defaults, chosen against the flagship example rather than in the abstract.
 *
 * X + Instagram, one compose and one publish each, is 2 planning + 2 compose =
 * 4. The per-step second call covers a length violation, which on a bad day
 * happens on both platforms, giving 6. Twelve leaves room for a three-account
 * goal doing the same and still refuses anything unbounded.
 */
export const DEFAULT_SPEND_LIMITS: SpendLimits = {
  perPlan: 2,
  perStep: 2,
  perRun: 12,
};

export type SpendDecision =
  | { allowed: true; /** Calls consumed so far in this run, including this one. */ used: number }
  | {
      allowed: false;
      /** `plan` or `run` — which cap stopped it. */
      scope: "plan" | "step" | "run";
      message: string;
    };

export interface SpendMeter {
  /** Model calls consumed by this run so far. */
  readonly used: number;
  /** Calls still available to the run. */
  remaining(): number;
  /** Take one unit for a planning call. */
  takePlan(): SpendDecision;
  /** Take one unit for a step's tool, bounded by the per-step and per-run caps. */
  takeStep(stepKey: string): SpendDecision;
}

/**
 * A meter for one run.
 *
 * Holds nothing but counters, and is not persisted. That is safe because the
 * meter is a *ceiling*, not a ledger: losing it on a crash resets the allowance
 * to full, and the queue's own retry count is what bounds how often that can
 * happen. Persisting it would add a write to the hot path to defend against a
 * case the retry policy already caps.
 */
export function createSpendMeter(
  limits: SpendLimits = DEFAULT_SPEND_LIMITS,
): SpendMeter {
  let total = 0;
  let planCalls = 0;
  const stepCalls = new Map<string, number>();

  const exhausted = (scope: "plan" | "step" | "run", message: string): SpendDecision => ({
    allowed: false,
    scope,
    message,
  });

  return {
    get used() {
      return total;
    },

    remaining() {
      return Math.max(0, limits.perRun - total);
    },

    takePlan() {
      if (planCalls >= limits.perPlan) {
        return exhausted(
          "plan",
          `This run has already used its budget of ${limits.perPlan} planning call${
            limits.perPlan === 1 ? "" : "s"
          }.`,
        );
      }
      if (total >= limits.perRun) {
        return exhausted(
          "run",
          `This run reached its budget of ${limits.perRun} AI call${limits.perRun === 1 ? "" : "s"} before it finished planning.`,
        );
      }
      planCalls += 1;
      total += 1;
      return { allowed: true, used: total };
    },

    takeStep(stepKey: string) {
      const already = stepCalls.get(stepKey) ?? 0;
      if (already >= limits.perStep) {
        return exhausted(
          "step",
          `Step ${stepKey} reached its budget of ${limits.perStep} AI call${
            limits.perStep === 1 ? "" : "s"
          }.`,
        );
      }
      if (total >= limits.perRun) {
        return exhausted(
          "run",
          `This run reached its budget of ${limits.perRun} AI call${limits.perRun === 1 ? "" : "s"}.`,
        );
      }
      stepCalls.set(stepKey, already + 1);
      total += 1;
      return { allowed: true, used: total };
    },
  };
}
