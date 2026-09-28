/**
 * Read models for the screens.
 *
 * ## Why this module exists at all
 *
 * `runtime/service.ts` has readers — `getRun`, `listRunSteps`, `listRunEvents` —
 * and they are deliberately unscoped. They are called by the executor and the
 * resume path, which have already been handed a `runId` by the queue and are
 * not in a position to ask whose run it is. Scoping them to a user would mean
 * threading an owner through every internal call for no gain.
 *
 * That makes them exactly the wrong functions for a page. `getRun` answers
 * "does this run exist", and a page that calls it and renders what it gets will
 * cheerfully show one tenant's plan, step input, and connector errors to another
 * tenant who guessed a UUID. Run ids are `randomUUID`, so guessing is not
 * practical — but "not practical" is not the property a tenancy boundary is
 * supposed to rest on, and this module makes the safe call the only one
 * available from the UI by making `getRun` unreachable from it.
 *
 * So: every function here takes a `userId` and puts it in the `WHERE` clause.
 * Not as a filter applied afterwards. In the query, so a row that is not the
 * caller's never exists in memory to be rendered by mistake.
 *
 * ## The rule this establishes
 *
 * A screen never calls `runtime/service.ts` for user-facing data. It calls this.
 * The distinction is not style: it is the difference between "the page can only
 * show you your own runs" and "the page shows whatever the function it happened
 * to call returns".
 *
 * ## What a caller still has to do
 *
 * Scope is necessary, not sufficient. A screen must also not render what a run
 * *contains* to a reader who should not see it — which, in this product, is
 * nobody: a run belongs to the account that caused it. The narrower concern is
 * that this module returns the raw step `input` and `result`, because the run
 * log genuinely needs to show what was published. Callers rendering a run list
 * should take `RunSummary`, which carries no content, rather than the detail
 * shape.
 */

import "server-only";

import { and, asc, count, desc, eq, gte, inArray, lte } from "drizzle-orm";

import { db } from "@/db";
import { goals, runEvents, runStepApprovals, runs, runSteps } from "@/db/schema";
import {
  listAccounts,
  listAccountsNeedingAttention,
  listSelectableAccounts,
} from "@/lib/accounts/store";

import { EXECUTION_STATES, type ExecutionState } from "./state";

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** How many rows a list screen will ever ask for. */
export const MAX_LIST_LIMIT = 200;

/**
 * A cap on what a `limit` may be.
 *
 * A history screen passes a constant; the clamp exists so a `?limit=` in a URL
 * cannot ask the database for the whole table. A history that is genuinely too
 * long for one page is a reason to build pagination, not to let a request size
 * itself from the query string.
 */
export function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);
}

/** One run, as a list row. Carries no step content and no error detail. */
export interface RunSummary {
  id: string;
  goalId: string;
  /** The goal's title, so a list need not be joined against on the client. */
  goalTitle: string;
  state: string;
  scheduleSlot: string;
  attempt: number;
  /** The short reason a run ended, when it failed. */
  errorSummary: string | null;
  /** How many steps the plan had. */
  stepCount: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

interface RunRow {
  id: string;
  goalId: string;
  goalTitle: string;
  state: string;
  scheduleSlot: string;
  attempt: number;
  errorSummary: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

/**
 * Step counts for a set of runs, in one query.
 *
 * Separate from the run query rather than a correlated subquery per row: a
 * history page asks for 50 runs, and 50 round trips to count rows is a latency
 * bill paid for data the page will not use in a join. Returns a map so a run
 * with no steps — a bare run, or one that never got planned — reads as `0`
 * rather than as a missing key the caller has to remember to handle.
 */
async function stepCountsFor(
  runIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (runIds.length === 0) return counts;

  const rows = await db
    .select({ runId: runSteps.runId, total: count(runSteps.id) })
    .from(runSteps)
    .where(inArray(runSteps.runId, [...runIds]))
    .groupBy(runSteps.runId);

  for (const row of rows) counts.set(row.runId, row.total);
  return counts;
}

function toSummary(row: RunRow, steps: number): RunSummary {
  return {
    id: row.id,
    goalId: row.goalId,
    goalTitle: row.goalTitle,
    state: row.state,
    scheduleSlot: row.scheduleSlot,
    attempt: row.attempt,
    errorSummary: row.errorSummary,
    stepCount: steps,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

/**
 * A user's runs, newest first, across every goal.
 *
 * The goal title is joined in rather than fetched afterwards: a history list
 * showing bare run ids is a list of ids, and the join is on the same index the
 * run query already uses.
 *
 * `goalId` narrows to one goal. It is not validated against the goal's owner
 * here — a goal belonging to someone else matches no runs, because
 * `runs.userId` is in the same `WHERE`. That is the point of carrying `userId`
 * rather than resolving the goal first: one clause, and no path where a caller
 * forgets to check.
 */
export async function listRuns(
  userId: string,
  options: { limit?: number; goalId?: string; state?: ExecutionState } = {},
): Promise<RunSummary[]> {
  const limit = clampLimit(options.limit, 25);

  const filters = [eq(runs.userId, userId)];
  if (options.goalId) filters.push(eq(runs.goalId, options.goalId));
  if (options.state) filters.push(eq(runs.state, options.state));

  const rows = await db
    .select({
      id: runs.id,
      goalId: runs.goalId,
      goalTitle: goals.title,
      state: runs.state,
      scheduleSlot: runs.scheduleSlot,
      attempt: runs.attempt,
      errorSummary: runs.errorSummary,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .innerJoin(goals, eq(runs.goalId, goals.id))
    .where(and(...filters))
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  const counts = await stepCountsFor(rows.map((row) => row.id));

  return rows.map((row) => toSummary(row, counts.get(row.id) ?? 0));
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

/** A step, as the run log renders it. */
export interface StepView {
  id: string;
  stepIndex: number;
  label: string;
  capability: string;
  targetAccount: string | null;
  state: string;
  input: string | null;
  result: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** An event, as the run log renders it. */
export interface EventView {
  id: string;
  stepId: string | null;
  level: string;
  event: string;
  detail: string | null;
  at: Date;
}

/** Everything the run page needs, in one call. */
export interface RunDetail {
  run: RunSummary;
  steps: StepView[];
  events: EventView[];
  /**
   * The approval this run is waiting on, if any.
   *
   * Read rather than derived from `run.state`, because the two are written by
   * different statements and there is a window between them: the approval is
   * settled first, and the run is transitioned by the resume that follows. A
   * page that inferred "this run needs an answer" from the run state alone
   * would, in that window, show a question that has already been answered.
   */
  pendingApproval: {
    id: string;
    tool: string;
    targetAccount: string | null;
    input: Record<string, unknown>;
    expiresAt: Date;
  } | null;
}

/**
 * One run and its whole history, or `null`.
 *
 * `null` is the answer for both "no such run" and "not yours", deliberately.
 * Distinguishing them would let a caller confirm that an id it guessed exists
 * in someone else's account, which is a tenancy leak with a nicer error message
 * attached.
 *
 * The run's `userId` is the scope. Not the goal's: they are the same today, but
 * they are different columns, and the run is what owns the step content being
 * returned here.
 */
export async function getRunDetail(
  userId: string,
  runId: string,
): Promise<RunDetail | null> {
  const [row] = await db
    .select({
      id: runs.id,
      goalId: runs.goalId,
      goalTitle: goals.title,
      state: runs.state,
      scheduleSlot: runs.scheduleSlot,
      attempt: runs.attempt,
      errorSummary: runs.errorSummary,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      createdAt: runs.createdAt,
    })
    .from(runs)
    .innerJoin(goals, eq(runs.goalId, goals.id))
    .where(and(eq(runs.id, runId), eq(runs.userId, userId)))
    .limit(1);

  if (!row) return null;

  const stepRows = await db
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .orderBy(asc(runSteps.stepIndex));

  const eventRows = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(asc(runEvents.at));

  const counts = await stepCountsFor([runId]);

  // Only the state a suspended run is suspended *on*. A run can have several
  // approval rows over its life — asked, expired, asked again on a retry — and
  // joining without the state filter would put three questions on one screen,
  // two of them answered. Newest first, because a run is never waiting on two
  // at once and the newest is the one it is actually blocked on.
  const [pending] = await db
    .select({
      id: runStepApprovals.id,
      tool: runStepApprovals.tool,
      targetAccount: runStepApprovals.targetAccount,
      input: runStepApprovals.input,
      expiresAt: runStepApprovals.expiresAt,
    })
    .from(runStepApprovals)
    .where(
      and(
        eq(runStepApprovals.runId, runId),
        eq(runStepApprovals.state, "pending"),
      ),
    )
    .orderBy(desc(runStepApprovals.createdAt))
    .limit(1);

  return {
    run: toSummary(row, counts.get(runId) ?? 0),
    steps: stepRows.map((step) => ({
      id: step.id,
      stepIndex: step.stepIndex,
      label: step.label,
      capability: step.capability,
      targetAccount: step.targetAccount,
      state: step.state,
      input: step.input,
      result: step.result,
      error: step.error,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    })),
    events: eventRows.map((event) => ({
      id: event.id,
      stepId: event.stepId,
      level: event.level,
      event: event.event,
      detail: event.detail,
      at: event.at,
    })),
    pendingApproval: pending
      ? {
          id: pending.id,
          tool: pending.tool,
          targetAccount: pending.targetAccount,
          input: parseInput(pending.input),
          expiresAt: pending.expiresAt,
        }
      : null,
  };
}

/**
 * A step's stored JSON, or `{}` when it will not parse.
 *
 * A snapshot the page cannot read is shown as an empty one. The approval is
 * still answerable — `decideApproval` re-reads its own copy and does not trust
 * this read — so failing to render the page would be a worse answer than
 * rendering a blank editor.
 */
function parseInput(raw: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Falls through to the empty object below.
  }
  return {};
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

/** Counts and short lists for the Runtime dashboard. */
export interface RuntimeOverview {
  goals: { active: number; paused: number; archived: number; total: number };
  runs: {
    /** In flight: claimed, executing, or waiting on a person. */
    inFlight: number;
    awaitingApproval: number;
    /** Finished in the last week, and how many of those failed. */
    recent: number;
    recentFailed: number;
  };
  approvals: { pending: number; /** Pending, but past their deadline. */ overdue: number };
  accounts: { total: number; enabled: number; needsAttention: number };
  /** The newest runs, for the dashboard's own list. */
  recentRuns: RunSummary[];
  /** A goal that is in the schedule but cannot act. */
  blockedGoals: number;
}

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Everything the Runtime dashboard shows, in one call.
 *
 * The counts are separate small queries rather than one large `GROUP BY`: each
 * one is a partial index or a narrow table, and a single statement aggregating
 * across `goals`, `runs`, `run_step_approvals` and `accounts` would be both
 * harder to read and impossible to index. Four round trips from the same process
 * is cheaper than one opaque one, and the queries are independent enough to run
 * together.
 *
 * `overdue` is a pending approval whose window has already closed but which the
 * sweeper has not yet expired. It is a *count of things that are about to
 * become failures*, and is deliberately not the same as "expired": showing a
 * user `expired: 0` while four of their approvals are past their deadline is
 * the sort of cheerful lie a dashboard exists to avoid. The window is a fixed
 * 24 hours, so this only happens between a deadline passing and the next sweep.
 */
export async function getRuntimeOverview(
  userId: string,
  now: Date = new Date(),
): Promise<RuntimeOverview> {
  const [goalRows, runCounts, recentRows, pendingApprovals, overdueApprovals, accountRows, attention, recentRunRows] =
    await Promise.all([
      db
        .select({ status: goals.status, total: count(goals.id) })
        .from(goals)
        .where(eq(goals.userId, userId))
        .groupBy(goals.status),

      db
        .select({ state: runs.state, total: count(runs.id) })
        .from(runs)
        .where(eq(runs.userId, userId))
        .groupBy(runs.state),

      db
        .select({ state: runs.state, total: count(runs.id) })
        .from(runs)
        .where(
          and(
            eq(runs.userId, userId),
            gte(runs.createdAt, new Date(now.getTime() - RECENT_WINDOW_MS)),
          ),
        )
        .groupBy(runs.state),

      countPendingApprovals(userId),

      countOverdueApprovals(userId, now),

      listAccounts(userId),
      listAccountsNeedingAttention(userId),
      listRuns(userId, { limit: 8 }),
    ]);

  const byGoalStatus = new Map(goalRows.map((row) => [row.status, row.total]));
  const byRunState = new Map(runCounts.map((row) => [row.state, row.total]));
  const byRecentState = new Map(recentRows.map((row) => [row.state, row.total]));

  const inFlight = (["pending", "running"] as const).reduce(
    (total, state) => total + (byRunState.get(state) ?? 0),
    0,
  );
  const awaitingApproval = byRunState.get("awaiting_approval") ?? 0;

  const activeGoals = byGoalStatus.get("active") ?? 0;
  const enabledAccounts = accountRows.filter((account) => account.enabled).length;

  // A goal in the schedule that is not going to fire. Both reasons are
  // checked by asking about the accounts rather than by reading a column: a
  // goal's targets are a JSON list, and whether they can still act is a property
  // of the accounts behind them.
  let blockedGoals = 0;
  if (activeGoals > 0) {
    const publishable = await listSelectableAccounts(userId, "publish_post");
    const keys = new Set(publishable.map((account) => account.accountKey));
    const goalTargets = await db
      .select({ targetAccounts: goals.targetAccounts })
      .from(goals)
      .where(and(eq(goals.userId, userId), eq(goals.status, "active")));

    for (const goal of goalTargets) {
      const targets = parseTargets(goal.targetAccounts);
      if (targets.length === 0 || targets.some((key) => !keys.has(key))) {
        blockedGoals += 1;
      }
    }
  }

  return {
    goals: {
      active: activeGoals,
      paused: byGoalStatus.get("paused") ?? 0,
      archived: byGoalStatus.get("archived") ?? 0,
      total: goalRows.reduce((total, row) => total + row.total, 0),
    },
    runs: {
      inFlight,
      awaitingApproval,
      recent: recentRows.reduce((total, row) => total + row.total, 0),
      recentFailed: byRecentState.get("failed") ?? 0,
    },
    approvals: { pending: pendingApprovals, overdue: overdueApprovals },
    accounts: {
      total: accountRows.length,
      enabled: enabledAccounts,
      needsAttention: attention.length,
    },
    recentRuns: recentRunRows,
    blockedGoals,
  };
}

/** How many approvals a user still has to answer. */
async function countPendingApprovals(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count(runStepApprovals.id) })
    .from(runStepApprovals)
    .where(
      and(
        eq(runStepApprovals.userId, userId),
        eq(runStepApprovals.state, "pending"),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Pending approvals the server will now refuse.
 *
 * `expires_at <= now` is the exact negation of `isOverdue`, which is `now >=
 * expiresAt`. Writing the same boundary twice in the two places that need it is
 * deliberate rather than lazy: a reader and a writer that cannot disagree is
 * worth one duplicated expression, and the alternative — importing the helper
 * into a `WHERE` clause — would be a comparison with a function call on the
 * column, which is a different plan and a slower query.
 *
 * This counts approvals that are *about* to expire, not ones that already have.
 * A dashboard reporting `expired: 0` while four of the user's approvals are past
 * their deadline is exactly the cheerful lie a dashboard exists to avoid, and
 * the sweeper may be up to five minutes from turning that zero into a number.
 */
async function countOverdueApprovals(userId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({ total: count(runStepApprovals.id) })
    .from(runStepApprovals)
    .where(
      and(
        eq(runStepApprovals.userId, userId),
        eq(runStepApprovals.state, "pending"),
        lte(runStepApprovals.expiresAt, now),
      ),
    );
  return row?.total ?? 0;
}

function parseTargets(raw: string | null): string[] {
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

/** The states a run can be in, for a filter control. */
export const RUN_STATES_FOR_FILTER: readonly ExecutionState[] = EXECUTION_STATES;
