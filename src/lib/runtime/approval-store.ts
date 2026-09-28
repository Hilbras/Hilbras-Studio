/**
 * Approvals and policies — persistence, and the gate the executor asks.
 *
 * ## Two tables, two jobs
 *
 * `execution_policies` is *configuration*: what this user has decided, ahead of
 * time, about their own actions. `run_step_approvals` is a *question*: one step
 * of one run, asked once, answered once.
 *
 * The split matters because they are read at different moments. A policy is read
 * by the plan gate before a model call is spent, and again immediately before
 * dispatch. An approval is written after the plan was accepted, by the step
 * about to act.
 *
 * ## A decision writes one fact and nothing else
 *
 * `decideApproval` records the answer. It does not touch the step, the run, or
 * the queue. All of that happens in the resume path, which means there is exactly
 * one place that moves a run out of `awaiting_approval` and exactly one place
 * that executes an approved step — rather than a decision path and a timeout path
 * that each grew their own version of both.
 *
 * The cost is that a decision has to *reach* the resume path, and the queue is
 * not transactional with Postgres. That is what `listApprovalsNeedingResume` is
 * for: it finds decisions whose step is still waiting, which is exactly the set
 * that a crash between the write and the send would leave behind. A run
 * therefore cannot be stuck permanently by a lost queue message — only delayed
 * by one sweep.
 *
 * ## Where the policy is read
 *
 * Once per gate, and a gate is built once per run. A policy that changes while a
 * run is mid-execution is not seen by that run — and does not need to be, because
 * a run takes seconds while a suspension takes hours, and a resumed run builds a
 * fresh gate. The case that matters, a user switching a policy off while their
 * post is waiting for approval, is covered by the *approval* path: `disabled`
 * beats a recorded approval below, so approving does not override a policy the
 * user has since changed.
 */

import "server-only";

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { executionPolicies, runStepApprovals, runs, runSteps } from "@/db/schema";
import { resolveAccount } from "@/lib/accounts/store";
import { isPlatformId, PLATFORM_REGISTRY } from "@/lib/platforms";

import {
  APPROVAL_STATES,
  applyEdit,
  approvalDeadline,
  approvalExpiredError,
  approvalRejectedError,
  approvableToolFor,
  approvableToolNames,
  DECIDED_STATES,
  isApprovableTool,
  isOverdue,
  policyDeniedError,
  POLICY_SCOPES,
  validatePolicyTarget,
  type ApprovalDecision,
  type ApprovalState,
  type PolicyScope,
  type StepPermissionGate,
} from "./approvals";
import { policyFor, type ExecutionPolicy, type PolicyDecision } from "./plan";
import { recordEvent } from "./service";
import { getTool } from "./tools";

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const DECISIONS: readonly PolicyDecision[] = ["auto", "approval", "disabled"];

/**
 * A decision read back off a row.
 *
 * `null` for anything not in the closed set, so an unrecognised value becomes
 * "no rule" rather than a policy that happens to mean something else. A policy
 * table is written by a settings screen and read by the last gate before a
 * publish, and neither of those should have to trust the other.
 */
function coerceDecision(value: string): PolicyDecision | null {
  return (DECISIONS as readonly string[]).includes(value)
    ? (value as PolicyDecision)
    : null;
}

/**
 * A user's policy, in the shape the plan gate already understands.
 *
 * `policyFor` applies the precedence — per-account over per-tool over the
 * default — and it was written and tested in v0.3.0. This function's only job is
 * to turn rows into the two maps it reads, so there is one implementation of the
 * precedence rule rather than two.
 */
export async function loadPolicy(userId: string): Promise<ExecutionPolicy> {
  const rows = await db
    .select({
      scope: executionPolicies.scope,
      scopeKey: executionPolicies.scopeKey,
      decision: executionPolicies.decision,
    })
    .from(executionPolicies)
    .where(eq(executionPolicies.userId, userId));

  const byAccount: Record<string, PolicyDecision> = {};
  const byCapability: Record<string, PolicyDecision> = {};

  for (const row of rows) {
    const decision = coerceDecision(row.decision);
    if (!decision) continue;
    if (row.scope === "account") byAccount[row.scopeKey] = decision;
    else if (row.scope === "tool") byCapability[row.scopeKey] = decision;
  }

  return { defaultDecision: "auto", byAccount, byCapability };
}

/** Every policy row a user has set, for a settings screen. */
export async function listPolicyRows(userId: string) {
  return db
    .select()
    .from(executionPolicies)
    .where(eq(executionPolicies.userId, userId));
}

/**
 * A user's set policies, keyed `scope:key`, already coerced.
 *
 * The screen that renders them needs a `PolicyDecision` for every row it shows,
 * and the column is a plain `text` — so a row written by a newer build, or by
 * hand, can carry anything. Coercing here rather than at the call site means one
 * implementation of "an unrecognised decision is no rule" instead of one per
 * screen, and it is the *same* `coerceDecision` `loadPolicy` uses, so a policy
 * read for the last gate before a publish and a policy read for a settings table
 * cannot disagree about what a row means.
 *
 * An unrecognised decision is dropped rather than surfaced: the gate would ignore
 * it, so showing it as a fourth option would describe a control that does
 * nothing.
 */
export async function policyDecisionsFor(
  userId: string,
): Promise<Map<string, PolicyDecision>> {
  const rows = await listPolicyRows(userId);
  const decisions = new Map<string, PolicyDecision>();

  for (const row of rows) {
    const decision = coerceDecision(row.decision);
    if (decision) decisions.set(`${row.scope}:${row.scopeKey}`, decision);
  }

  return decisions;
}

export type SetPolicyResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Set one policy, or refuse.
 *
 * A refusal is a refusal, not a silent no-op: a settings screen that accepts
 * "require approval" for a tool that changes nothing would leave the user
 * believing their account is gated when it is not.
 */
export async function setPolicy(
  userId: string,
  scope: PolicyScope,
  scopeKey: string,
  decision: PolicyDecision,
): Promise<SetPolicyResult> {
  if (!(DECISIONS as readonly string[]).includes(decision)) {
    return { ok: false, reason: `"${decision}" is not a decision.` };
  }

  const accounts = await db.query.accounts.findMany({
    where: (table, operators) => operators.eq(table.userId, userId),
    columns: { accountKey: true },
  });

  const target = validatePolicyTarget(scope, scopeKey, {
    accountKeys: accounts.map((account) => account.accountKey),
  });
  if (!target.ok) return { ok: false, reason: target.reason };

  await db
    .insert(executionPolicies)
    .values({ id: randomUUID(), userId, scope, scopeKey, decision })
    .onConflictDoUpdate({
      target: [executionPolicies.userId, executionPolicies.scope, executionPolicies.scopeKey],
      set: { decision },
    });

  return { ok: true };
}

/**
 * Remove one policy, returning to `auto`.
 *
 * Always allowed, including for an account key the user no longer holds. The
 * alternative is a disconnected account leaving a policy nobody can clear, and a
 * stuck setting is worse than a stale one.
 */
export async function clearPolicy(
  userId: string,
  scope: PolicyScope,
  scopeKey: string,
): Promise<boolean> {
  const removed = await db
    .delete(executionPolicies)
    .where(
      and(
        eq(executionPolicies.userId, userId),
        eq(executionPolicies.scope, scope),
        eq(executionPolicies.scopeKey, scopeKey),
      ),
    )
    .returning({ id: executionPolicies.id });

  return removed.length > 0;
}

/** The scopes, and what may be named in each, for a settings screen. */
export async function describePolicyTargets(userId: string) {
  const accounts = await db.query.accounts.findMany({
    where: (table, operators) => operators.eq(table.userId, userId),
    columns: { accountKey: true, platform: true },
  });

  return {
    accounts: accounts.map((account) => account.accountKey),
    tools: approvableToolNames(),
  };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/** One approval row, as read back. */
export interface StepApproval {
  id: string;
  runId: string;
  stepId: string;
  userId: string;
  tool: string;
  targetAccount: string | null;
  /** The resolved input, parsed. `{}` when the stored JSON is unusable. */
  input: Record<string, unknown>;
  state: ApprovalState;
  decidedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

function coerceState(value: string): ApprovalState {
  return (APPROVAL_STATES as readonly string[]).includes(value)
    ? (value as ApprovalState)
    : "pending";
}

function parseInput(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toApproval(row: typeof runStepApprovals.$inferSelect): StepApproval {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    userId: row.userId,
    tool: row.tool,
    targetAccount: row.targetAccount,
    input: parseInput(row.input),
    state: coerceState(row.state),
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/** The approval for a step, or `null` if the step was never gated. */
export async function getStepApproval(stepId: string): Promise<StepApproval | null> {
  const [row] = await db
    .select()
    .from(runStepApprovals)
    .where(eq(runStepApprovals.stepId, stepId))
    .limit(1);
  return row ? toApproval(row) : null;
}

/**
 * The approval with this id, or `null`.
 *
 * The resume trigger carries an approval id rather than a step id, and needs to
 * read the decision before it can decide whether there is any work to do — so
 * the two ids cannot be assumed to be interchangeable. A resume naming an
 * approval that is still pending, or one that has been deleted with its run, is
 * "nothing to do" rather than an error: the sweeper re-sends, and a run that no
 * longer exists cannot need doing.
 */
export async function getStepApprovalById(
  approvalId: string,
): Promise<StepApproval | null> {
  const [row] = await db
    .select()
    .from(runStepApprovals)
    .where(eq(runStepApprovals.id, approvalId))
    .limit(1);
  return row ? toApproval(row) : null;
}

/**
 * Ask a person about a step, or return the question already asked.
 *
 * Idempotent per step, which is what makes it safe inside the queue's
 * `step.run` closure: a replay of that closure must not produce a second
 * question for the same post. The unique constraint on `step_id` decides the
 * race and the existing row is returned, with **its** original deadline — so a
 * replay cannot extend a window a user is already counting down.
 */
export async function requestApproval(input: {
  runId: string;
  stepId: string;
  userId: string;
  tool: string;
  targetAccount?: string | null;
  /** The resolved input. Stored as the thing the person will be shown. */
  input: Record<string, unknown>;
  now?: Date;
}): Promise<StepApproval> {
  const now = input.now ?? new Date();
  const id = randomUUID();

  await db
    .insert(runStepApprovals)
    .values({
      id,
      runId: input.runId,
      stepId: input.stepId,
      userId: input.userId,
      tool: input.tool,
      targetAccount: input.targetAccount ?? null,
      input: JSON.stringify(input.input),
      state: "pending",
      expiresAt: approvalDeadline(now),
    })
    .onConflictDoNothing({ target: runStepApprovals.stepId });

  const stored = await getStepApproval(input.stepId);
  if (!stored) {
    throw new Error(`Approval for step ${input.stepId} vanished after insert`);
  }

  if (stored.id === id) {
    await recordEvent(input.runId, {
      stepId: input.stepId,
      level: "info",
      event: "approval.requested",
      detail: {
        approvalId: stored.id,
        tool: stored.tool,
        targetAccount: stored.targetAccount,
        expiresAt: stored.expiresAt.toISOString(),
      },
    });
  }

  return stored;
}

/** Approvals a user still has to answer, newest first. */
export async function listPendingApprovals(userId: string): Promise<StepApproval[]> {
  const rows = await db
    .select()
    .from(runStepApprovals)
    .where(
      and(
        eq(runStepApprovals.userId, userId),
        eq(runStepApprovals.state, "pending"),
      ),
    )
    .orderBy(sql`${runStepApprovals.createdAt} desc`);

  return rows.map(toApproval);
}

export type DecideResult =
  | {
      ok: true;
      approval: StepApproval;
      /** The input the step will run with — the snapshot, plus any edit. */
      input: Record<string, unknown>;
      changed: string[];
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "forbidden"
        | "already_decided"
        | "approval_expired"
        | "invalid_edit";
      message: string;
      /** Per-field problems, when the edit was the problem. */
      issues?: string[];
    };

/** The character limit the target platform puts on this step's text. */
async function fieldLimitsFor(
  userId: string,
  targetAccount: string | null,
): Promise<Record<string, number>> {
  if (!targetAccount) return {};

  const account = await resolveAccount(userId, targetAccount);
  if (!account || !isPlatformId(account.platform)) return {};

  const limit = PLATFORM_REGISTRY[account.platform].content.maxTextLength;
  return limit === null ? {} : { text: limit };
}

/**
 * Record a person's answer.
 *
 * Writes the decision and nothing else. The step, the run's state, and the queue
 * are all handled by the resume path, so there is one place where an approval
 * becomes an action.
 *
 * The order of the checks is the order of the ways this can go wrong:
 *
 * 1. **Who is asking.** A decision is only the goal owner's to make. Checked
 *    against the approval's own `userId`, not the run's, so it is one read.
 * 2. **Whether it was already answered.** Two answers means two people believed
 *    they were first, and the second one must not silently change the content.
 * 3. **Whether the window closed.** A late answer is refused *and* the approval is
 *    marked expired, because the alternative is a window that a user can still
 *    answer after the fact — which makes the deadline meaningless. Marking it
 *    here rather than leaving it for the sweeper means the two paths cannot
 *    disagree about what happened.
 * 4. **The edit.** Last, and only on an approval, because an edit on a rejection
 *    is a contradiction rather than a request.
 */
export async function decideApproval(input: {
  approvalId: string;
  userId: string;
  decision: ApprovalDecision;
  /** Field values to replace. Only fields the tool marks editable. */
  edit?: Readonly<Record<string, unknown>>;
  now?: Date;
}): Promise<DecideResult> {
  const now = input.now ?? new Date();

  const [row] = await db
    .select()
    .from(runStepApprovals)
    .where(eq(runStepApprovals.id, input.approvalId))
    .limit(1);

  if (!row) {
    return { ok: false, code: "not_found", message: "There is no such approval." };
  }

  const approval = toApproval(row);

  if (approval.userId !== input.userId) {
    return {
      ok: false,
      code: "forbidden",
      message: "This approval is not yours to answer.",
    };
  }

  if (approval.state !== "pending") {
    return {
      ok: false,
      code: "already_decided",
      message: `This post was already ${approval.state}.`,
    };
  }

  if (isOverdue(approval.expiresAt, now)) {
    await markExpired(approval);
    return {
      ok: false,
      code: "approval_expired",
      message: `This approval closed at ${approval.expiresAt.toISOString()} without an answer, so the post was not published.`,
    };
  }

  const tool = getTool(approval.tool);
  let nextInput = approval.input;
  let changed: string[] = [];

  if (input.edit && Object.keys(input.edit).length > 0) {
    if (input.decision !== "approved") {
      return {
        ok: false,
        code: "invalid_edit",
        message: "An edit only makes sense on an approval, not a rejection.",
      };
    }
    if (!tool) {
      return {
        ok: false,
        code: "invalid_edit",
        message: `"${approval.tool}" is not a tool this build has.`,
      };
    }

    const edit = applyEdit(approval.input, input.edit, tool, {
      fieldLimits: await fieldLimitsFor(approval.userId, approval.targetAccount),
    });
    if (!edit.ok) {
      return {
        ok: false,
        code: "invalid_edit",
        message: "The edit was not accepted.",
        issues: edit.issues,
      };
    }
    nextInput = edit.input;
    changed = edit.changed;
  }

  const [updated] = await db
    .update(runStepApprovals)
    .set({ state: input.decision, decidedAt: now })
    .where(
      and(
        eq(runStepApprovals.id, approval.id),
        // The condition, not just the value read above: two answers arriving at
        // once both pass the `state` check above, and only one of them may write.
        eq(runStepApprovals.state, "pending"),
      ),
    )
    .returning();

  if (!updated) {
    return {
      ok: false,
      code: "already_decided",
      message: "This post was already answered.",
    };
  }

  await recordEvent(approval.runId, {
    stepId: approval.stepId,
    level: input.decision === "approved" ? "info" : "warn",
    event: `approval.${input.decision}`,
    detail: { approvalId: approval.id, ...(changed.length > 0 ? { edited: changed } : {}) },
  });

  return { ok: true, approval: toApproval(updated), input: nextInput, changed };
}

/** Mark one approval expired. Idempotent. */
async function markExpired(approval: StepApproval): Promise<void> {
  const [updated] = await db
    .update(runStepApprovals)
    .set({ state: "expired", decidedAt: new Date() })
    .where(
      and(
        eq(runStepApprovals.id, approval.id),
        eq(runStepApprovals.state, "pending"),
      ),
    )
    .returning({ id: runStepApprovals.id });

  if (!updated) return;

  await recordEvent(approval.runId, {
    stepId: approval.stepId,
    level: "warn",
    event: "approval.expired",
    detail: { approvalId: approval.id, expiresAt: approval.expiresAt.toISOString() },
  });
}

/**
 * Expire every approval nobody answered.
 *
 * Writes the decision only — the resume path does the rest, and this function is
 * how an expiry reaches it. The partial index on `expires_at WHERE state =
 * 'pending'` makes this one index scan over a table whose decided rows vastly
 * outnumber its live ones.
 *
 * The per-row event is a second statement per expired approval. N is bounded by
 * how many approvals a user left unanswered, which is small, and the history is
 * the only place a user can find out *why* their run did not publish.
 */
export async function expireOverdueApprovals(now = new Date()): Promise<StepApproval[]> {
  const expired = await db
    .update(runStepApprovals)
    .set({ state: "expired", decidedAt: now })
    .where(
      and(
        eq(runStepApprovals.state, "pending"),
        // `lte(deadline, now)` — at the deadline the window is already closed, so
        // this is exactly `isOverdue`. The reader refuses a late answer and this
        // closes it; if the two disagreed about the boundary, a decision could be
        // refused by one and still published by a resume that read it in between.
        lte(runStepApprovals.expiresAt, now),
      ),
    )
    .returning();

  const approvals: StepApproval[] = [];
  for (const row of expired) {
    const approval = toApproval(row);
    await recordEvent(approval.runId, {
      stepId: approval.stepId,
      level: "warn",
      event: "approval.expired",
      detail: { approvalId: approval.id, expiresAt: approval.expiresAt.toISOString() },
    });
    approvals.push(approval);
  }

  return approvals;
}

/**
 * Decisions that have not been picked up yet.
 *
 * The safety net for a lost queue message. A decision is "picked up" when the
 * step it was about stops being `awaiting_approval`, so the join on `run_steps`
 * is what makes this converge: once the resume runs, the step is `completed` or
 * `failed` and the row drops out of this set. Re-sending is therefore harmless
 * and the comparison-and-swap on the step stops a duplicate dispatch.
 */
export async function listApprovalsNeedingResume(): Promise<StepApproval[]> {
  const rows = await db
    .select({ approval: runStepApprovals })
    .from(runStepApprovals)
    .innerJoin(runSteps, eq(runSteps.id, runStepApprovals.stepId))
    .innerJoin(runs, eq(runs.id, runStepApprovals.runId))
    .where(
      and(
        inArray(runStepApprovals.state, [...DECIDED_STATES]),
        eq(runSteps.state, "awaiting_approval"),
        eq(runs.state, "awaiting_approval"),
      ),
    );

  return rows.map((row) => toApproval(row.approval));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * The executor's permission gate for one user.
 *
 * Three answers, in this order:
 *
 * - **Not an approvable tool.** Allowed. `compose_post` changes nothing outside
 *   this system, and putting a question in front of a step that cannot publish
 *   would be a question with no consequence behind it.
 * - **A recorded approval.** Allowed. This is the path a resumed run takes, and
 *   it is why the gate is idempotent: the same step is asked once and executed
 *   once, and the second visit finds the answer rather than asking again.
 * - **The policy.** `disabled` denies outright, `approval` asks, and `auto`
 *   allows.
 *
 * `disabled` is checked *before* the recorded approval, and that ordering is the
 * point. A user who switches a policy to `disabled` while their post waits for
 * approval means it, and approving afterwards must not publish something the
 * policy now forbids — an approval is consent to a permitted action, not a
 * licence to perform a forbidden one.
 *
 * A step whose approval was rejected or has expired is denied with the matching
 * error, so the executor reaches the right outcome however it got there. In
 * practice the resume path settles those steps before they reach the gate; this
 * is the layer that makes the answer correct without depending on that.
 */
export function createApprovalGate(userId: string): StepPermissionGate {
  let policyPromise: Promise<ExecutionPolicy> | null = null;
  const policy = (): Promise<ExecutionPolicy> => {
    policyPromise ??= loadPolicy(userId);
    return policyPromise;
  };

  return async (request) => {
    const tool = approvableToolFor(request.tool);
    if (!tool) return { kind: "allow" };

    const decision = policyFor(await policy(), {
      capability: request.tool,
      targetAccount: request.targetAccount ?? undefined,
    });

    if (decision === "disabled") {
      return {
        kind: "deny",
        error: policyDeniedError(request.tool, request.targetAccount),
      };
    }

    const existing = await getStepApproval(request.stepId);

    if (existing?.state === "approved") return { kind: "allow" };

    if (existing?.state === "rejected") {
      return { kind: "deny", error: approvalRejectedError(existing.targetAccount) };
    }

    if (existing?.state === "expired") {
      return { kind: "deny", error: approvalExpiredError(existing.targetAccount) };
    }

    if (existing) {
      // Pending. An overdue pending approval is still pending here — the sweeper
      // is what turns it into `expired` — so a run that reaches a step whose
      // window has closed asks about it again rather than publishing, and the
      // answer is a refusal either way.
      return {
        kind: "needs_approval",
        approvalId: existing.id,
        expiresAt: existing.expiresAt,
      };
    }

    if (decision === "auto") return { kind: "allow" };

    const created = await requestApproval({
      runId: request.runId,
      stepId: request.stepId,
      userId,
      tool: request.tool,
      targetAccount: request.targetAccount,
      input: request.input,
    });

    return {
      kind: "needs_approval",
      approvalId: created.id,
      expiresAt: created.expiresAt,
    };
  };
}

/** The scopes a policy may be written in, re-exported so callers need one import. */
export { POLICY_SCOPES, isApprovableTool };
