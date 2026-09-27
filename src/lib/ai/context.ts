/**
 * What the planner is shown.
 *
 * ## Why this module is separate from the prompt
 *
 * The prompt is prose; this is data. Keeping them apart means the set of facts
 * that cross into model output can be read, reviewed, and tested on its own
 * terms — which matters more than usual here, because this is the boundary
 * where a user's account list and a user's own words go out to a third party.
 *
 * `docs/ai/context.md` records the full list. The short version:
 *
 * **What crosses:** the goal's title, the goal's statement verbatim, the
 * accounts this goal targets (with each platform's limits and rules), the
 * outcome of this goal's recent firings, and — on a repair attempt — the
 * validation issues the last plan produced.
 *
 * **What does not:** credentials, tokens, any account outside this goal's
 * target list, the user's `posts` table, the Assistant's memory, and every
 * other user. Notably absent is the content of previous posts: a planner shown
 * what it wrote last time is measurably worse at writing something new, and
 * feeding it history to fix that would mean handing the model the user's
 * published archive on every firing.
 *
 * That absence is a Phase 5 decision, and it is reversible in one place.
 */

import { PLATFORM_REGISTRY, isPlatformId } from "@/lib/platforms";

/** One target account, as the planner sees it. */
export interface PlannerAccount {
  /** `platform:handle`. The only form a step's `targetAccount` may take. */
  id: string;
  platform: string;
  /** Display name, e.g. "X". */
  name: string;
  handle: string | null;
  /** Hard character limit, or null when the platform states none. */
  maxTextLength: number | null;
  /** The platform's own rules, in its words. */
  rules: string[];
}

/**
 * One previous firing, reduced to whether it worked.
 *
 * No step labels, no error messages, no text. A run's `errorSummary` can
 * contain a connector's message, and a connector message can contain whatever
 * the platform chose to echo — so the reason is a code from a closed set
 * instead, and the *step* is a capability name this build already knows.
 */
export interface PlannerHistoryEntry {
  /** The schedule slot, e.g. "2026-09-27T10:00Z". */
  slot: string;
  state: string;
  /** How many steps the plan had. */
  steps: number;
  /** The tool that failed, when the run failed at a step. */
  failedTool?: string;
}

export interface PlannerContext {
  goalTitle: string;
  /** The user's own words, unmodified. Never summarised, never rephrased. */
  statement: string;
  accounts: PlannerAccount[];
  /** Recent firings of this goal, oldest first. */
  history: PlannerHistoryEntry[];
  /**
   * Why the previous plan was refused, for a repair attempt.
   *
   * Present only when re-planning. Empty on the first attempt, and the prompt
   * says so — a planner told "here is why that failed" when nothing has failed
   * invents a failure to fix.
   */
  repairNotes: string[];
}

/**
 * The platform facts a post has to be written against.
 *
 * Read from the platform registry rather than from a connector, because this
 * runs before any account is resolved and must work for a platform whose
 * adapter has not been consulted yet. A platform this build does not know gets
 * the honest answer — no limit, no rules — instead of a guess.
 */
export function describePlatformFor(platform: string): {
  name: string;
  maxTextLength: number | null;
  rules: string[];
} {
  if (!isPlatformId(platform)) {
    return { name: platform, maxTextLength: null, rules: [] };
  }
  const spec = PLATFORM_REGISTRY[platform];
  return {
    name: spec.name,
    maxTextLength: spec.content.maxTextLength,
    rules: spec.content.rules,
  };
}

/** An account as the planner sees it, from an id and a platform. */
export function toPlannerAccount(input: {
  id: string;
  platform: string;
  handle: string | null;
}): PlannerAccount {
  const described = describePlatformFor(input.platform);
  return {
    id: input.id,
    platform: input.platform,
    name: described.name,
    handle: input.handle,
    maxTextLength: described.maxTextLength,
    rules: described.rules,
  };
}

/**
 * Render the context as the user half of the planner prompt.
 *
 * Every value is interpolated inside a tagged block so the model can tell where
 * the user's own words begin and end. The statement in particular is the one
 * place untrusted text enters the prompt, and it is data the model is
 * *instructed* to follow — a goal whose statement contains what looks like a
 * second set of instructions must not be able to widen its own permissions. It
 * cannot: the gate checks the resulting plan against the account list and the
 * tool registry regardless of what the statement said.
 */
export function renderPlannerContext(ctx: PlannerContext): string {
  const accounts = ctx.accounts
    .map((account) => {
      const limit =
        account.maxTextLength === null
          ? "no stated character limit"
          : `at most ${account.maxTextLength} characters`;
      const rules =
        account.rules.length > 0
          ? `\n      rules: ${account.rules.join(" | ")}`
          : "";
      return `    - id: ${account.id}  (${account.name}${account.handle ? `, @${account.handle}` : ""})\n      limit: ${limit}${rules}`;
    })
    .join("\n");

  const history =
    ctx.history.length > 0
      ? ctx.history
          .map((entry) => {
            const steps = `${entry.steps} step${entry.steps === 1 ? "" : "s"}`;
            // The two facts are separate: the run's own state, and whether one
            // of its steps failed. Running them together as "failed at x" or
            // "pending at x" makes it ambiguous which is which.
            const failure = entry.failedTool
              ? ` — a step failed at ${entry.failedTool}`
              : "";
            return `    - ${entry.slot}: ${entry.state} (${steps})${failure}`;
          })
          .join("\n")
      : "    - none yet";

  const repair =
    ctx.repairNotes.length > 0
      ? `\n<why_the_last_plan_was_refused>\n${ctx.repairNotes
          .map((note) => `  - ${note}`)
          .join("\n")}\n</why_the_last_plan_was_refused>\n`
      : "";

  return `<goal>
  <title>${ctx.goalTitle}</title>
  <statement>${ctx.statement}</statement>
</goal>

<accounts>
${accounts}
</accounts>

<recent_firings>
${history}
</recent_firings>${repair}`;
}
