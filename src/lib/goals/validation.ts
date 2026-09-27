/**
 * Goal validation — the gate between "the user described something" and "we
 * will run this on a schedule".
 *
 * This module is pure. It takes the resolved accounts as an argument rather
 * than importing the accounts store, so the whole gate is testable without
 * Postgres. That matters more here than for plan validation, because a goal is
 * the one thing in the Runtime a user configures *once* and then forgets: a
 * goal saved against an account that cannot act will not fail loudly, it will
 * simply never publish, and the user has no reason to look again.
 *
 * So every rule below exists to refuse a goal **now**, while the user is still
 * looking at the form, rather than to fail it later, when the only visible
 * symptom is silence.
 *
 * The plan gate (`lib/runtime/plan.ts`) checks the same properties about a
 * generated plan, and must keep checking them: a goal validated today can have
 * its account disconnected tomorrow, and the planner's output is untrusted by
 * construction. Neither gate replaces the other.
 */

import {
  describeCron,
  isValidTimeZone,
  nextSlot,
  parseCron,
  type CronFields,
} from "./cron";

/**
 * The closest two firings of one goal may be.
 *
 * A goal publishes on every firing, so this is also the floor on how often the
 * product can post to a single account on the user's behalf. Fifteen minutes is
 * well inside every platform's rate limit and comfortably below the frequency
 * at which repeated identical posts start looking like abuse to the platform and
 * getting the grant revoked — a failure that costs the user their connection,
 * not just this goal.
 *
 * Exported because the reason it exists is worth stating wherever a schedule
 * is refused.
 */
export const MIN_GOAL_INTERVAL_MS = 15 * 60 * 1000;

/** How many consecutive firings are probed to enforce the floor above. */
const INTERVAL_PROBE_DEPTH = 4;

/** An account a goal may target, in the shape validation needs. */
export interface GoalTarget {
  /** `platform:handle`, e.g. "x:hilbras". */
  id: string;
  platform: string;
  /** A disabled account must never be a goal target. */
  enabled: boolean;
  capabilities: readonly string[];
}

export type GoalIssueCode =
  | "empty_title"
  | "title_too_long"
  | "empty_statement"
  | "statement_too_long"
  | "invalid_schedule"
  | "invalid_timezone"
  /** Parses, but names a date that never occurs, like February 30th. */
  | "unsatisfiable_schedule"
  | "schedule_too_frequent"
  | "no_targets"
  | "malformed_target"
  | "duplicate_target"
  | "unknown_account"
  | "account_disabled"
  | "capability_unavailable";

export interface GoalIssue {
  code: GoalIssueCode;
  /** The offending account, for the issues that name one. */
  target?: string;
  message: string;
}

export interface GoalDraft {
  title: string;
  statement: string;
  /** Raw cron from the form. Validated and canonicalised here. */
  schedule: string;
  timeZone: string;
  targetAccounts: readonly string[];
  /** When the goal is being saved; the next firing is computed from it. */
  from?: Date;
}

export interface ValidatedGoal {
  title: string;
  statement: string;
  /** The canonical expression, not the user's spacing. */
  cron: string;
  timeZone: string;
  /** De-duplicated, input order preserved. */
  targetAccounts: string[];
  /** The first firing, so the scheduler has something to select on. */
  nextFiringAt: Date;
  /** A sentence the form can show back for confirmation. */
  description: string;
  fields: CronFields;
}

export type GoalValidation =
  | { ok: true; value: ValidatedGoal }
  | { ok: false; issues: GoalIssue[] };

/** `platform:handle`, both parts non-empty. */
const ACCOUNT_KEY = /^[^:\s]+:\S+$/;

const MAX_TITLE = 120;
/**
 * Bounded because the statement is handed to the planner verbatim. A
 * megabyte-long "goal" is not a goal, and it becomes a prompt-injection surface
 * the moment a model reads it.
 */
const MAX_STATEMENT = 4000;

/**
 * Validate a goal draft against the accounts the user actually has.
 *
 * Collects *every* issue rather than failing on the first, so someone filling in
 * a form sees the whole list instead of rediscovering one problem per save.
 */
export function validateGoal(
  draft: GoalDraft,
  targets: readonly GoalTarget[],
): GoalValidation {
  const issues: GoalIssue[] = [];
  const from = draft.from ?? new Date();

  // --- text ---------------------------------------------------------------
  const title = (draft.title ?? "").trim();
  if (!title) {
    issues.push({ code: "empty_title", message: "The goal needs a name." });
  } else if (title.length > MAX_TITLE) {
    issues.push({
      code: "title_too_long",
      message: `The name must be ${MAX_TITLE} characters or fewer.`,
    });
  }

  const statement = (draft.statement ?? "").trim();
  if (!statement) {
    issues.push({
      code: "empty_statement",
      message: "Describe what the goal should do.",
    });
  } else if (statement.length > MAX_STATEMENT) {
    issues.push({
      code: "statement_too_long",
      message: `The description must be ${MAX_STATEMENT} characters or fewer.`,
    });
  }

  // --- schedule -----------------------------------------------------------
  const parsed = parseCron(draft.schedule ?? "");
  if (!parsed.ok) {
    issues.push({ code: "invalid_schedule", message: parsed.error });
  }

  const timeZone = (draft.timeZone ?? "").trim() || "UTC";
  if (!isValidTimeZone(timeZone)) {
    issues.push({
      code: "invalid_timezone",
      message: `"${draft.timeZone}" is not a time zone this system knows.`,
    });
  }

  let nextFiringAt: Date | null = null;

  if (parsed.ok && isValidTimeZone(timeZone)) {
    const first = nextSlot(parsed.fields, timeZone, from);

    if (!first) {
      // Parses cleanly and can never fire. `0 0 30 2 *` is February 30th.
      issues.push({
        code: "unsatisfiable_schedule",
        message: "This schedule never comes round. Check the day and month.",
      });
    } else {
      nextFiringAt = first;

      // The floor, checked by probing real slots rather than by reading the
      // expression. `*/30 * * * *` and `0,30 * * * *` mean the same thing, and
      // only the first looks suspicious.
      let cursor = first;
      for (let depth = 1; depth < INTERVAL_PROBE_DEPTH; depth += 1) {
        const following = nextSlot(parsed.fields, timeZone, cursor);
        if (!following) break;

        const gap = following.getTime() - cursor.getTime();
        if (gap < MIN_GOAL_INTERVAL_MS) {
          issues.push({
            code: "schedule_too_frequent",
            message: `A goal publishes on every firing, so this runs more often than once every ${MIN_GOAL_INTERVAL_MS / 60000} minutes.`,
          });
          break;
        }
        cursor = following;
      }
    }
  }

  // --- targets ------------------------------------------------------------
  const requested = (draft.targetAccounts ?? []).map((key) => key.trim());
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const key of requested) {
    if (!key) continue;

    if (!ACCOUNT_KEY.test(key)) {
      issues.push({
        code: "malformed_target",
        target: key,
        message: `"${key}" is not an account. Accounts look like "x:hilbras".`,
      });
      continue;
    }

    if (seen.has(key)) {
      issues.push({
        code: "duplicate_target",
        target: key,
        message: `"${key}" is listed more than once.`,
      });
      continue;
    }
    seen.add(key);
    unique.push(key);
  }

  if (unique.length === 0 && issues.every((issue) => issue.code !== "malformed_target")) {
    issues.push({
      code: "no_targets",
      message: "Choose at least one account to publish to.",
    });
  }

  const byId = new Map(targets.map((target) => [target.id, target]));

  for (const key of unique) {
    const account = byId.get(key);
    if (!account) {
      // Either the user typed it, or their connection is gone. Both mean the
      // same thing to the goal: it cannot run. Distinct from `disabled`, which
      // means the account is there and the user chose to switch it off.
      issues.push({
        code: "unknown_account",
        target: key,
        message: `No connected account matches "${key}".`,
      });
      continue;
    }

    if (!account.enabled) {
      issues.push({
        code: "account_disabled",
        target: key,
        message: `"${key}" is switched off. Turn it on to publish there.`,
      });
      continue;
    }

    // A goal's whole purpose is to publish. A platform that completes OAuth but
    // has no publisher — LinkedIn, TikTok, and four others — is connectable and
    // visibly incapable, and that has to be said at configuration time. Waiting
    // until the first firing would look like a silent failure.
    if (!account.capabilities.includes("publish_post")) {
      issues.push({
        code: "capability_unavailable",
        target: key,
        message: `${account.platform} cannot publish yet. Choose a platform that can.`,
      });
    }
  }

  if (issues.length > 0 || !parsed.ok || !nextFiringAt) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      title,
      statement,
      cron: parsed.expression,
      timeZone,
      targetAccounts: unique,
      nextFiringAt,
      description: describeCron(parsed.fields),
      fields: parsed.fields,
    },
  };
}
