/**
 * Goal persistence — the only module that writes `goals`.
 *
 * Everything here is server-only. The invariant it exists to protect is the one
 * `docs/goals.md` states: `schedule_cron` holds an **already-validated** value,
 * parsed once at the edge, so the scheduler never re-parses user input. Every
 * write path therefore runs the draft through `validateGoal` first, and there is
 * no exported function that writes a schedule which has not been through it.
 *
 * ## Why `next_firing_at` is written here and nowhere else
 *
 * The column is derived from `schedule_cron` and `schedule_timezone`. Every
 * mutation that can change either of those recomputes it in the same statement
 * that changes them, so the scheduler can never observe a schedule and a firing
 * time that disagree. A goal that is paused gets NULL rather than a stale
 * instant — a paused goal that still looks due is a paused goal that publishes.
 *
 * ## Why target accounts are validated here rather than at fire time
 *
 * A goal is configured once and then forgotten. If the account is disconnected
 * or switched off at save time and nothing says so, the goal sits there looking
 * healthy and produces nothing, forever. Every refusal is therefore collected
 * and returned together, not thrown one at a time.
 */

import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { accounts, goals, runSteps, runs } from "@/db/schema";
import { capabilitiesForAccount } from "@/lib/accounts/store";

import {
  isValidTimeZone,
  nextSlot,
  parseCron,
  slotKey,
} from "./cron";
import {
  GOAL_STATUSES,
  validateGoal,
  type GoalDraft,
  type GoalIssue,
  type GoalStatus,
  type GoalTarget,
} from "./validation";

/**
 * Re-exported so the rest of the app has one import for the goal vocabulary.
 *
 * The values are defined in `./validation`, which is pure, because the client
 * reads them too. This module cannot be that import site: it is `server-only`,
 * and a badge that cannot name the state it is rendering is a badge that
 * restates the union by hand.
 */
export { GOAL_STATUSES, type GoalStatus };

/**
 * Re-exported so a caller that already imports the service does not need a
 * second import path to name what the service returns.
 */
export type { GoalIssue };

function isGoalStatus(value: string): value is GoalStatus {
  return (GOAL_STATUSES as readonly string[]).includes(value);
}

export type CreateGoalResult =
  | {
      ok: true;
      goalId: string;
      /**
       * The next firing, or `null` when the goal is not active. An edit to a
       * paused goal leaves it paused, so there is nothing due and nothing to
       * report — a sentinel instant would be a lie the scheduler would have to
       * be taught to ignore.
       */
      nextFiringAt: Date | null;
    }
  | { ok: false; issues: GoalIssue[] };

/**
 * The user's accounts, in the shape validation needs.
 *
 * A single query rather than one per target: the gate refuses the whole draft,
 * so it needs to see every account at once to explain all the problems rather
 * than the first one.
 */
async function goalTargets(userId: string): Promise<GoalTarget[]> {
  const rows = await db
    .select({
      accountKey: accounts.accountKey,
      platform: accounts.platform,
      enabled: accounts.enabled,
      capabilities: accounts.capabilities,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));

  return rows.map((row) => ({
    id: row.accountKey,
    platform: row.platform,
    enabled: row.enabled,
    capabilities: capabilitiesForAccount(row),
  }));
}

/**
 * Create a goal, or explain every reason it cannot be created.
 *
 * Returns issues rather than throwing: this is called from a form, and a caller
 * needs a list to render, not a stack trace.
 */
export async function createGoal(
  userId: string,
  draft: GoalDraft,
): Promise<CreateGoalResult> {
  const targets = await goalTargets(userId);
  const validation = validateGoal(draft, targets);
  if (!validation.ok) return { ok: false, issues: validation.issues };

  const { value } = validation;
  const id = randomUUID();

  await db.insert(goals).values({
    id,
    userId,
    title: value.title,
    statement: value.statement,
    scheduleCron: value.cron,
    scheduleTimezone: value.timeZone,
    targetAccounts: JSON.stringify(value.targetAccounts),
    status: "active",
    nextFiringAt: value.nextFiringAt,
  });

  return { ok: true, goalId: id, nextFiringAt: value.nextFiringAt };
}

export interface UpdateGoalPatch {
  title?: string;
  statement?: string;
  schedule?: string;
  timeZone?: string;
  targetAccounts?: readonly string[];
}

/**
 * Edit a goal.
 *
 * Changing the schedule or the accounts re-runs the **whole** validation, not
 * just the changed field. A user editing a goal's title is not asking to have
 * their account disconnected, and an edit is the natural moment to say so — but
 * only if the gate is asked again. Re-validating everything is also what makes
 * this safe: a partial check would let an edit carry a new schedule past the
 * gate on the strength of a field that was never re-checked.
 *
 * A goal that fails the gate is left exactly as it was. There is no partial
 * update and no "save anyway".
 */
export async function updateGoal(
  userId: string,
  goalId: string,
  patch: UpdateGoalPatch,
): Promise<CreateGoalResult> {
  const existing = await getGoal(userId, goalId);
  if (!existing) {
    return {
      ok: false,
      issues: [{ code: "unknown_account", message: "That goal no longer exists." }],
    };
  }

  const draft: GoalDraft = {
    title: patch.title ?? existing.title,
    statement: patch.statement ?? existing.statement,
    schedule: patch.schedule ?? existing.scheduleCron,
    timeZone: patch.timeZone ?? existing.scheduleTimezone,
    targetAccounts: patch.targetAccounts ?? existing.targetAccounts,
  };

  const targets = await goalTargets(userId);
  const validation = validateGoal(draft, targets);
  if (!validation.ok) return { ok: false, issues: validation.issues };

  const { value } = validation;
  const scheduleChanged =
    value.cron !== existing.scheduleCron ||
    value.timeZone !== existing.scheduleTimezone;

  // A paused goal stays paused through an edit, and keeps no firing time. An
  // edit must not be a way to sneak a paused goal back into the schedule.
  const active = existing.status === "active";

  await db
    .update(goals)
    .set({
      title: value.title,
      statement: value.statement,
      scheduleCron: value.cron,
      scheduleTimezone: value.timeZone,
      targetAccounts: JSON.stringify(value.targetAccounts),
      updatedAt: new Date(),
      nextFiringAt: active
        ? scheduleChanged
          ? value.nextFiringAt
          : existing.nextFiringAt
        : null,
    })
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId)));

  return {
    ok: true,
    goalId,
    nextFiringAt: active
      ? (scheduleChanged
          ? value.nextFiringAt
          : (existing.nextFiringAt ?? value.nextFiringAt))
      : null,
  };
}

export type SetGoalStatusResult =
  | { ok: true; status: GoalStatus }
  | { ok: false; message: string };

/**
 * Pause, resume, or archive a goal.
 *
 * Resuming recomputes the next firing **from now**, not from the old one. A goal
 * paused for a month and resumed would otherwise be instantly due and, under an
 * older catch-up policy, fire a month of posts at once. "From now" is what the
 * user means by resuming: it starts again.
 *
 * `now` is a parameter so a caller — and the tests — can say what "now" is. It
 * defaults to the clock, and a test that asserted a resumed goal's firing time
 * against its own idea of today would be a test that fails every morning.
 */
export async function setGoalStatus(
  userId: string,
  goalId: string,
  status: GoalStatus,
  now: Date = new Date(),
): Promise<SetGoalStatusResult> {
  if (!isGoalStatus(status)) {
    return { ok: false, message: `"${status}" is not a goal status.` };
  }

  const existing = await getGoal(userId, goalId);
  if (!existing) return { ok: false, message: "That goal no longer exists." };

  // An archived goal is terminal. Re-activating one would be a re-creation with
  // the same id and a history that no longer matches, so it is refused.
  if (existing.status === "archived" && status !== "archived") {
    return {
      ok: false,
      message: "An archived goal cannot be resumed. Create it again instead.",
    };
  }

  let nextFiringAt: Date | null = null;

  if (status === "active") {
    // The stored cron was validated when it was written, but parse defensively
    // anyway: a goal row that predates the validator, or one edited in the
    // database by hand, must not leave the scheduler with a firing time that
    // nothing can reproduce.
    const parsed = parseCron(existing.scheduleCron);
    if (!parsed.ok || !isValidTimeZone(existing.scheduleTimezone)) {
      return {
        ok: false,
        message: `This goal's schedule is no longer valid: ${
          parsed.ok ? `"${existing.scheduleTimezone}" is not a time zone` : parsed.error
        }. Edit the schedule before resuming.`,
      };
    }

    nextFiringAt = nextSlot(parsed.fields, existing.scheduleTimezone, now);
    if (!nextFiringAt) {
      return {
        ok: false,
        message: "This goal's schedule never comes round. Edit it before resuming.",
      };
    }
  }

  await db
    .update(goals)
    .set({ status, nextFiringAt, updatedAt: new Date() })
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId)));

  return { ok: true, status };
}

export interface GoalRecord {
  id: string;
  title: string;
  statement: string;
  scheduleCron: string;
  /** Named after the column, so a field is never a translation of another. */
  scheduleTimezone: string;
  targetAccounts: string[];
  status: GoalStatus;
  nextFiringAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: typeof goals.$inferSelect): GoalRecord {
  return {
    id: row.id,
    title: row.title,
    statement: row.statement,
    scheduleCron: row.scheduleCron,
    scheduleTimezone: row.scheduleTimezone,
    targetAccounts: parseTargetAccounts(row.targetAccounts),
    status: isGoalStatus(row.status) ? row.status : "active",
    nextFiringAt: row.nextFiringAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Read the target list back.
 *
 * A malformed column must not make a goal unreadable — the same reasoning as
 * `capabilitiesForAccount`. The goal is still shown, with no targets, rather
 * than failing to render at all; a user who can see the goal can fix it, and a
 * user whose page throws cannot.
 */
function parseTargetAccounts(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** One goal, scoped to its owner. `null` for a goal that is not theirs. */
export async function getGoal(
  userId: string,
  goalId: string,
): Promise<GoalRecord | null> {
  const [row] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.userId, userId)))
    .limit(1);

  return row ? toRecord(row) : null;
}

/** A user's goals, newest first. */
export async function listGoals(userId: string): Promise<GoalRecord[]> {
  const rows = await db
    .select()
    .from(goals)
    .where(eq(goals.userId, userId))
    .orderBy(desc(goals.createdAt));

  return rows.map(toRecord);
}

// --- The scheduler's side ---------------------------------------------------

export interface DueGoal {
  id: string;
  userId: string;
  scheduleCron: string;
  scheduleTimezone: string;
  /** The slot that just came due. */
  dueAt: Date;
}

/**
 * Goals whose firing time has arrived.
 *
 * The query the `goals_due_idx` partial index exists for, and it repeats the
 * index's predicate on purpose — a partial index does not imply the filter, so a
 * query that leaned on that would be correct today and wrong the day someone
 * widened the index.
 */
export async function listDueGoals(now: Date, limit = 100): Promise<DueGoal[]> {
  const rows = await db
    .select({
      id: goals.id,
      userId: goals.userId,
      scheduleCron: goals.scheduleCron,
      scheduleTimezone: goals.scheduleTimezone,
      dueAt: goals.nextFiringAt,
    })
    .from(goals)
    .where(
      and(
        eq(goals.status, "active"),
        isNotNull(goals.nextFiringAt),
        lte(goals.nextFiringAt, now),
      ),
    )
    .orderBy(asc(goals.nextFiringAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    scheduleCron: row.scheduleCron,
    scheduleTimezone: row.scheduleTimezone,
    dueAt: row.dueAt as Date,
  }));
}

/**
 * Advance a goal past a firing it has just been dispatched for.
 *
 * The next slot is computed from `now`, not from the slot that just fired, so
 * **missed firings collapse into one**. A goal that posts twice a day and missed
 * a weekend comes back and posts once, not five times. The alternative — one
 * catch-up run per missed slot — turns an outage into a spam run, and the run
 * that is genuinely due is not more important than the ones after it.
 *
 * `null` when the schedule is unsatisfiable, which stops the goal being selected
 * forever rather than looping on a row that can never advance.
 */
export async function advanceGoal(
  goalId: string,
  from: Date,
): Promise<Date | null> {
  const [row] = await db
    .select({ cron: goals.scheduleCron, timeZone: goals.scheduleTimezone })
    .from(goals)
    .where(eq(goals.id, goalId))
    .limit(1);

  if (!row) return null;

  const parsed = parseCron(row.cron);
  const next =
    parsed.ok && isValidTimeZone(row.timeZone)
      ? nextSlot(parsed.fields, row.timeZone, from)
      : null;

  await db
    .update(goals)
    .set({ nextFiringAt: next, updatedAt: new Date() })
    .where(eq(goals.id, goalId));

  return next;
}

/** A goal's most recent runs, newest first. */
export async function listRecentRuns(goalId: string, limit = 10) {
  return db
    .select({
      id: runs.id,
      state: runs.state,
      scheduleSlot: runs.scheduleSlot,
      attempt: runs.attempt,
      // `createdAt` because it is the only one of the three that every run has:
      // a queued run has no `startedAt` yet, and a run whose dispatch failed
      // before it was claimed has no `finishedAt` either. Ordering is already
      // by `createdAt`, so a history that rendered `startedAt` would be missing
      // the runs it is most likely to be asked about.
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
    })
    .from(runs)
    .where(eq(runs.goalId, goalId))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
}

/** One firing, as the planner is allowed to see it. */
export interface FiringHistory {
  /** The schedule slot, e.g. "2026-09-27T10:00Z". */
  slot: string;
  state: string;
  /** How many steps that run's plan had. */
  steps: number;
  /** The first tool that failed, when the run failed at a step. */
  failedTool?: string;
}

/**
 * A goal's recent firings, reduced to whether they worked.
 *
 * Two things are deliberately not in here: the content of the steps, and the
 * error text. The planner gets enough to notice "the last three firings all
 * died at publish_post" and change its approach, and nothing that would let a
 * previous post be fed back in as something to vary against.
 *
 * The failed step is reported as a *tool name* rather than as a message because
 * a run's `error` column can contain a connector's own text, and a connector
 * message can contain whatever the platform chose to echo. A name from a closed
 * set cannot.
 *
 * `excludeRunId` drops the run being planned. Without it a goal's own in-flight
 * firing appears in its context as "running, 0 steps", which is noise at best
 * and a prompt for the model to second-guess a plan it is still producing.
 */
export async function listFiringHistory(
  goalId: string,
  options: { limit?: number; excludeRunId?: string } = {},
): Promise<FiringHistory[]> {
  const { limit = 5, excludeRunId } = options;

  const recent = await db
    .select({ id: runs.id, state: runs.state, scheduleSlot: runs.scheduleSlot })
    .from(runs)
    .where(eq(runs.goalId, goalId))
    .orderBy(desc(runs.createdAt))
    .limit(limit + 1);

  const candidates = recent
    .filter((run) => run.id !== excludeRunId)
    .slice(0, limit);
  if (candidates.length === 0) return [];

  const steps = await db
    .select({
      runId: runSteps.runId,
      stepIndex: runSteps.stepIndex,
      capability: runSteps.capability,
      state: runSteps.state,
    })
    .from(runSteps)
    .where(inArray(runSteps.runId, candidates.map((run) => run.id)))
    .orderBy(asc(runSteps.stepIndex));

  const byRun = new Map<string, typeof steps>();
  for (const step of steps) {
    const list = byRun.get(step.runId);
    if (list) list.push(step);
    else byRun.set(step.runId, [step]);
  }

  return candidates.map((run) => {
    const runSteps_ = byRun.get(run.id) ?? [];
    const failed = runSteps_.find((step) => step.state === "failed");
    return {
      slot: run.scheduleSlot,
      state: run.state,
      steps: runSteps_.length,
      ...(failed ? { failedTool: failed.capability } : {}),
    };
  });
}

/**
 * A goal's health, derived from its runs rather than stored.
 *
 * The last run's state is the only honest answer to "is this working", and it
 * cannot be cached on the goal row: a run finishes without the goal being
 * touched, so a denormalised copy would be stale exactly when it mattered.
 */
export type GoalHealth =
  | "never_run"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_attention";

export async function goalHealth(goalId: string): Promise<GoalHealth> {
  const recent = await listRecentRuns(goalId, 1);
  const last = recent[0];
  if (!last) return "never_run";

  switch (last.state) {
    case "completed":
      return "succeeded";
    case "running":
    case "pending":
      return "running";
    // A run can fail for a reason no retry will fix — an expired grant, a
    // revoked scope. Retrying it is the user's decision, not the system's, so
    // this is called out separately from an ordinary failure.
    case "failed":
      return "needs_attention";
    case "awaiting_approval":
      return "needs_attention";
    default:
      return "never_run";
  }
}

/** The slots a goal has already run, for the history view. */
export async function listRunSlots(goalId: string): Promise<string[]> {
  const rows = await db
    .select({ slot: runs.scheduleSlot })
    .from(runs)
    .where(eq(runs.goalId, goalId));

  return rows.map((row) => row.slot);
}

/** The slot a goal's next run will use, for display before it exists. */
export function upcomingSlot(goal: GoalRecord): string | null {
  return goal.nextFiringAt ? slotKey(goal.nextFiringAt) : null;
}
