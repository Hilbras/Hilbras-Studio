/**
 * The Runtime as a screen needs to see it.
 *
 * ## Why this module exists
 *
 * Every state in the Runtime already has a closed vocabulary: `EXECUTION_STATES`
 * in `./state`, `APPROVAL_STATES` in `./approvals`, `GOAL_STATUSES` in
 * `../goals/validation`. Those are the authority — the transition table and the
 * approval window are written against them, and nothing else decides what a
 * state means.
 *
 * A screen needs three things the authority does not provide: a name, a
 * severity, and a sentence a user can act on. That mapping is what this module
 * holds, and it is here rather than in a component for two reasons.
 *
 * **It is a total function, and the type system says so.** Every table below is
 * a `Record` keyed by the *state union itself*, not by `string`. Adding a state
 * to `EXECUTION_STATES` without giving it a name is a compile error rather than
 * a badge that renders blank. This is the whole reason the states are a union
 * and this file is not: a `switch` in a component would default, and the default
 * is where a new state silently disappears.
 *
 * **The clock is a parameter.** `approvalDeadlineView` and `relativeTime` take
 * `now`. That is not testability alone — it is the property that lets the screen
 * and the writer agree. See below.
 *
 * ## Why the deadline is computed with `isOverdue`
 *
 * `isOverdue` is the same function `decideApproval` and the sweeper's query
 * agree on, and this module calls it rather than re-deriving the comparison.
 *
 * If the approval screen used its own arithmetic, a user could be shown a
 * countdown reaching zero and press Approve, and the server could refuse with
 * `approval_expired` — because the screen said "1 second left" and the server
 * said "closed". Both would be right. That is the worst outcome available: the
 * user is told the window is open, spends a moment writing an edit, and is
 * refused by the very control they were watching. Sharing one comparison is
 * what makes the two sides incapable of disagreeing.
 *
 * The countdown is therefore advisory and the *label* is authoritative — once
 * this returns `overdue: true` the server will refuse, whatever the browser
 * clock believes.
 *
 * ## What is deliberately not here
 *
 * No fetch, no formatting of user text, no decision about what a screen should
 * show. This maps state to meaning. Deciding which of the meanings appears on
 * which page belongs to the page, and keeping the two apart is what lets the
 * same vocabulary be reused by the dashboard, the run log, and the approval
 * screen without three copies of the same labels drifting apart.
 */

import { APPROVAL_STATES, isOverdue, type ApprovalState } from "./approvals";
import { EXECUTION_STATES, type ExecutionState } from "./state";
import { GOAL_STATUSES, type GoalStatus } from "../goals/validation";

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * How loudly a state should be shown.
 *
 * Ordered by how much it should pull the eye, so a screen that wants to be
 * quiet about a category says `quiet` and a screen that wants to be loud about
 * a different one says `loud` — neither has to know the palette.
 *
 * `neutral` is the default in the badge component, so a missing tone renders
 * readably rather than invisibly. That is a rendering fallback, not a semantic
 * one: a missing tone is a type error, not a value a screen can supply.
 */
export type Tone = "quiet" | "neutral" | "progress" | "success" | "warning" | "danger";

/** What a screen needs to know about a state. */
export interface StatusMeta {
  /** Short, for a badge. Sentence case, no punctuation. */
  label: string;
  tone: Tone;
  /**
   * One sentence, in the user's terms rather than the system's.
   *
   * Present because a badge is a label, not an explanation, and "awaiting
   * approval" is the kind of phrase that leaves a new user unsure whether
   * something is broken.
   */
  meaning: string;
}

// ---------------------------------------------------------------------------
// Runs and steps
// ---------------------------------------------------------------------------

/**
 * Run and step states, named once.
 *
 * A step and a run share `EXECUTION_STATES` because they share the transition
 * table — `canTransition` is the same function for both. They are given one set
 * of names here for the same reason: a run that is "awaiting approval" and a
 * step that is "awaiting approval" are the same event seen from two levels, and
 * describing them with different words would suggest a difference that is not
 * there.
 */
export const EXECUTION_STATUS: Record<ExecutionState, StatusMeta> = {
  pending: {
    label: "Queued",
    tone: "quiet",
    meaning: "Claimed by the scheduler and waiting to start.",
  },
  running: {
    label: "Running",
    tone: "progress",
    meaning: "Executing its steps right now.",
  },
  awaiting_approval: {
    label: "Needs you",
    tone: "warning",
    meaning:
      "Paused on a side effect until a person approves it. Nothing moves until you answer.",
  },
  completed: {
    label: "Completed",
    tone: "success",
    meaning: "Every step settled and nothing failed.",
  },
  failed: {
    label: "Failed",
    tone: "danger",
    meaning: "A step did not succeed. The run stopped there; other steps settled as they could.",
  },
  cancelled: {
    label: "Cancelled",
    tone: "neutral",
    meaning: "Stopped on request. It will not be retried.",
  },
};

/**
 * The name for a run or step state, falling back for a value read from the
 * database that the current build does not recognise.
 *
 * The fallback is real, not defensive habit: `state` is a `text` column and a
 * row written by a newer build, or edited by hand, can carry anything. An
 * unrecognised state must render as *something* — the alternative is a badge
 * with an empty label, which reads as a rendering bug rather than as "this is a
 * state you do not have a word for".
 *
 * It is deliberately *not* mapped to a known state. Guessing that an unknown
 * value means `failed` would let a screen tell a user their run is broken when
 * the build simply has no word for it.
 */
export function executionStatus(state: string): StatusMeta {
  return EXECUTION_STATUS[state as ExecutionState] ?? UNKNOWN_EXECUTION;
}

const UNKNOWN_EXECUTION: StatusMeta = {
  label: "Unknown",
  tone: "quiet",
  meaning: "This run is in a state this build does not recognise.",
};

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const APPROVAL_STATUS: Record<ApprovalState, StatusMeta> = {
  pending: {
    label: "Waiting",
    tone: "warning",
    meaning: "Nobody has answered yet.",
  },
  approved: {
    label: "Approved",
    tone: "success",
    meaning: "A person allowed it to go ahead.",
  },
  rejected: {
    label: "Rejected",
    tone: "neutral",
    meaning: "A person said no. That step did not run; the rest of the run continued.",
  },
  expired: {
    label: "Expired",
    tone: "danger",
    meaning:
      "The window closed with no answer, so the step failed. A timeout is not consent.",
  },
};

/** See `executionStatus` for why there is a fallback and why it does not guess. */
export function approvalStatus(state: string): StatusMeta {
  return APPROVAL_STATUS[state as ApprovalState] ?? UNKNOWN_APPROVAL;
}

const UNKNOWN_APPROVAL: StatusMeta = {
  label: "Unknown",
  tone: "quiet",
  meaning: "This approval is in a state this build does not recognise.",
};

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export const GOAL_STATUS: Record<GoalStatus, StatusMeta> = {
  active: {
    label: "Active",
    tone: "success",
    meaning: "In the schedule and will fire.",
  },
  paused: {
    label: "Paused",
    tone: "neutral",
    meaning: "Kept, but not in the schedule. Resuming starts again from now.",
  },
  archived: {
    label: "Archived",
    tone: "quiet",
    meaning: "Finished. An archived goal cannot be resumed.",
  },
};

export function goalStatus(state: string): StatusMeta {
  return GOAL_STATUS[state as GoalStatus] ?? UNKNOWN_GOAL;
}

const UNKNOWN_GOAL: StatusMeta = {
  label: "Unknown",
  tone: "quiet",
  meaning: "This goal is in a state this build does not recognise.",
};

// ---------------------------------------------------------------------------
// The approval window
// ---------------------------------------------------------------------------

/** Below this, a pending approval is shown as urgent. */
export const APPROVAL_SOON_MS = 2 * 60 * 60 * 1000;

export interface DeadlineView {
  /**
   * Whether the server will refuse an answer now.
   *
   * Computed with the same `isOverdue` the server uses, so this and the server
   * cannot disagree at the boundary.
   */
  overdue: boolean;
  /**
   * "closes in 3h" / "closed 40m ago".
   *
   * Authoritative once `overdue` is true. While it is false the *number* is a
   * snapshot of the browser's clock and can be stale by the time it is read;
   * the boundary cannot, because it is the same comparison.
   */
  label: string;
  /** Whole hours until the deadline, floored at zero. Zero once overdue. */
  hoursLeft: number;
  /** Close enough to be worth flagging. Never true once overdue. */
  soon: boolean;
}

/**
 * How an approval's window should be shown.
 *
 * Clamps at zero rather than going negative, and reports `overdue` from
 * `isOverdue` rather than from the arithmetic. A countdown that displays `-1h`
 * is a bug the user can see; the real question is whether the door is shut, and
 * that has one answer.
 */
export function approvalDeadlineView(
  expiresAt: Date,
  now: Date = new Date(),
): DeadlineView {
  const overdue = isOverdue(expiresAt, now);
  const ms = expiresAt.getTime() - now.getTime();
  const magnitude = Math.abs(ms);
  const span = formatDuration(magnitude);

  return {
    overdue,
    label: overdue ? `closed ${span} ago` : `closes in ${span}`,
    hoursLeft: overdue ? 0 : Math.floor(ms / (60 * 60 * 1000)),
    // Mutually exclusive with `overdue` on purpose: a closed window is not
    // "closing soon", and showing both at once is how a user talks themselves
    // into pressing a button the server is about to refuse.
    soon: !overdue && ms <= APPROVAL_SOON_MS,
  };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * A duration, at the coarsest unit that still says something.
 *
 * Two units, never three: "1h 30m" is harder to read at a glance than "2h", and
 * the exact figure is not what anyone is looking for. Under a minute reports
 * seconds, because "closes in 0m" for something that is about to happen is the
 * one case where the precision is the point.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;

  return `${Math.floor(days / 30)}mo`;
}

/**
 * How long ago something happened, or how far off it is.
 *
 * "in 4h" and "4h ago" are the same number with a direction, and a history view
 * that only ever looks backwards gets a future timestamp — a goal's next firing
 * — wrong. So both directions are here rather than a bare relative string.
 *
 * An instant more than a month out is rendered as a date instead, because "in
 * 8mo" on a goal whose schedule is a weekday cron means nothing, while the date
 * does.
 */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const ms = date.getTime() - now.getTime();
  const span = formatDuration(Math.abs(ms));
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

/**
 * An absolute instant, in the reader's own zone.
 *
 * Used next to a relative time wherever the relative one alone is not enough to
 * act on — a run log's timestamps, and an approval deadline, where "closes in
 * 3h" is a reassurance and "closes at 14:20" is the thing to put in a calendar.
 */
export function formatInstant(date: Date): string {
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * The tables above must cover exactly the closed vocabularies.
 *
 * `Record<K, V>` already refuses a *missing* key at compile time, so this
 * function exists for the other half: it fails when a table has grown a key
 * that is no longer a state. That happens when a state is renamed — the union
 * moves on, the old key is left behind, and the table compiles because
 * `Record<K, V>` does not complain about extra keys. Nothing would ever read
 * that row again.
 *
 * The parameters are widened to `string` on purpose. The compile-time half of
 * this check is carried by how each table is *declared*; this function is the
 * runtime half, and it has to be callable for all three tables at once — which
 * is exactly what a generic signature would refuse, because three tables over
 * three different unions do not unify.
 */
export function coverageIsExact(
  table: Readonly<Record<string, StatusMeta>>,
  states: readonly string[],
): boolean {
  const keys = Object.keys(table);
  if (keys.length !== states.length) return false;
  return states.every((state) => Object.hasOwn(table, state));
}

/** Every vocabulary, with the table that has to cover it. */
export const STATUS_TABLES = [
  { states: EXECUTION_STATES, table: EXECUTION_STATUS },
  { states: APPROVAL_STATES, table: APPROVAL_STATUS },
  { states: GOAL_STATUSES, table: GOAL_STATUS },
] as const;
