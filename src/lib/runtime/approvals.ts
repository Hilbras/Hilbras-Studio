/**
 * Approvals — a person deciding whether a side effect may happen.
 *
 * ## What an approval is for
 *
 * `ToolSpec.sideEffect` is the whole of it. A tool that changes something
 * outside this system is one a person may want to see first; a tool that only
 * computes is not. Approval exists to put a human in front of the second kind of
 * action, so `compose_post` has no approval and `publish_post` always can.
 *
 * ## Why the approval holds *resolved* input
 *
 * A `publish_post` step normally takes its text from a `compose_post` earlier in
 * the plan, as `{"$ref": {"step": 0, "field": "text"}}`. That is not something a
 * person can approve: an approval screen showing a reference is a screen showing
 * a JSON object, and the one moment a human is actually reading the content is
 * the moment the content is not there.
 *
 * So the snapshot an approval carries is the input *after* reference resolution.
 * Two things follow, and both are the point:
 *
 * 1. What the person reads is exactly what will be published.
 * 2. An edit is an edit of the real text, not of a pointer to it.
 *
 * The cost is that the snapshot is not re-derivable from the plan alone. It is
 * persisted, which is why an approval row holds an `input` of its own.
 *
 * ## Why an edit is checked by the plan's own validator
 *
 * `applyEdit` merges the edit into the snapshot and hands the result to
 * `validateToolInput` — the identical function the plan gate uses. An approval
 * screen is a *later* stage than the gate, so a weaker check there would mean
 * the one place a person is looking at the content is the one place the content
 * is unchecked. A human who can write input no planner could write has found a
 * way around the plan gate, and the gate is what stops untrusted output from
 * naming a destination.
 *
 * ## Why a timeout fails rather than approves
 *
 * A timeout is an absence of consent. The user set this policy *because* they
 * wanted to see the post before it went out, and publishing it because they were
 * asleep is the exact opposite of what they asked for. So the deadline settles
 * the step as failed and the run moves on.
 *
 * ## What this module deliberately does not do
 *
 * It holds no policy resolution and no clock. `policyFor` lives in `./plan`
 * because the gate already owns that vocabulary, and the clock is injected so
 * every decision here is testable by passing a `Date`.
 */

import { validateToolInput } from "./plan";
import { isStepRef } from "./references";
import type { ConnectorError } from "@/lib/connectors/types";

import { getTool, toolCatalogue, type ToolSpec } from "./tools";

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export const APPROVAL_STATES = [
  "pending",
  "approved",
  "rejected",
  "expired",
] as const;

export type ApprovalState = (typeof APPROVAL_STATES)[number];

/** What a person can press. `expired` is not a choice, it is an absence. */
export type ApprovalDecision = "approved" | "rejected";

/** The states a decision has left behind, once it is no longer pending. */
export const DECIDED_STATES: readonly ApprovalState[] = [
  "approved",
  "rejected",
  "expired",
];

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * How long an approval stays answerable.
 *
 * A day, chosen against the thing it has to serve: a goal that fires daily and
 * needs approval should be answerable before the next firing, so a user who
 * approves once a day is not permanently one firing behind.
 *
 * A fixed constant rather than a per-policy setting, because the deadline is
 * **stamped onto the row when the approval is created**. Changing this number
 * later therefore cannot reinterpret a decision a user was in the middle of
 * making — a pending approval keeps the window it was created with.
 */
export const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** The deadline for an approval requested at `now`. */
export function approvalDeadline(now: Date): Date {
  return new Date(now.getTime() + APPROVAL_WINDOW_MS);
}

/**
 * Whether an approval's window has closed.
 *
 * `>=` and not `>`. The deadline is when the question stops, so at the instant
 * of the deadline it is already closed — "answerable until T" would mean
 * something a caller could not state without also saying "or just after".
 *
 * The same boundary appears in the sweeper's query, and the two have to agree:
 * if a reader refused an answer the sweeper had not yet expired, or the reverse,
 * then which one a given decision met would depend on the order two independent
 * statements happened to run in.
 */
export function isOverdue(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

// ---------------------------------------------------------------------------
// Which tools are approvable
// ---------------------------------------------------------------------------

/**
 * Whether a tool's action is one a person may gate.
 *
 * Reads `sideEffect`, which is declared per tool rather than inferred from
 * `capability !== null`. The inference would be wrong the moment a read-only
 * connector tool existed: it delegates to a platform, and it has no side effect,
 * and a policy derived from the wrong one of those two facts would put an
 * approval in front of a step that cannot publish anything.
 */
export function isApprovableTool(tool: ToolSpec): boolean {
  return tool.sideEffect;
}

/** The tool a named step runs, when that tool can be gated. */
export function approvableToolFor(name: string): ToolSpec | null {
  const tool = getTool(name);
  return tool && isApprovableTool(tool) ? tool : null;
}

// ---------------------------------------------------------------------------
// The gate's contract
// ---------------------------------------------------------------------------

/** What a step needs to be told before it can be considered for dispatch. */
export interface PermissionRequest {
  runId: string;
  stepId: string;
  /** The tool name, from the closed registry set. */
  tool: string;
  targetAccount?: string | null;
  /**
   * The step's input with every reference already resolved.
   *
   * Resolved, not stored, so a gate that records the request for a person to
   * look at is recording the content rather than a pointer to it. See the module
   * comment.
   */
  input: Record<string, unknown>;
}

export type StepPermission =
  | { kind: "allow" }
  | { kind: "deny"; error: ConnectorError }
  | {
      kind: "needs_approval";
      /** The approval row, created or already present. */
      approvalId: string;
      expiresAt: Date;
    };

/**
 * Decides whether one step may act.
 *
 * Required rather than optional on the executor's dependencies, with no
 * permissive default. A default that allowed everything would mean a call site
 * that forgot to wire it publishes unattended, and the wiring is one line — the
 * failure mode is not worth the convenience. The alternative default, requiring
 * approval for everything, would be safer and would make every test that is not
 * about approvals carry an approval it does not want.
 */
export type StepPermissionGate = (
  request: PermissionRequest,
) => Promise<StepPermission>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A policy forbids the action. Never retryable: the setting is the fix. */
export function policyDeniedError(
  tool: string,
  targetAccount?: string | null,
): ConnectorError {
  return {
    code: "policy_denied",
    message: `Policy does not allow "${tool}"${
      targetAccount ? ` on ${targetAccount}` : ""
    }. Change the policy in settings to allow it.`,
    retryable: false,
  };
}

/** A person said no. */
export function approvalRejectedError(targetAccount?: string | null): ConnectorError {
  return {
    code: "approval_rejected",
    message: `The post for ${targetAccount ?? "this account"} was not approved.`,
    retryable: false,
  };
}

/** Nobody answered in time. */
export function approvalExpiredError(targetAccount?: string | null): ConnectorError {
  return {
    code: "approval_expired",
    message: `The post for ${
      targetAccount ?? "this account"
    } was not approved within the review window, so it was not published.`,
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** The fields of a tool a person may replace, by name. */
export function editableFields(tool: ToolSpec): readonly string[] {
  return tool.fields.filter((field) => field.editable).map((field) => field.name);
}

export type EditResult =
  | {
      ok: true;
      /** The snapshot with the accepted edits applied. */
      input: Record<string, unknown>;
      /** Field names whose value actually changed. */
      changed: string[];
    }
  | { ok: false; issues: string[] };

/**
 * Apply a person's edits to the snapshot they were shown.
 *
 * Three rules, in this order, because each one is a way the approval screen
 * could become a way around the plan gate:
 *
 * 1. **Only fields the tool marks editable.** The human may change what the post
 *    says; they may not change which account it goes to, and they may not add a
 *    media URL. `editable` is a declaration on the field rather than a check
 *    here, so adding a field to a tool cannot make it silently writable.
 * 2. **No `$ref` in an edited value.** A `$ref` is valid plan input and
 *    `validateToolInput` rightly accepts one — but a person editing text is
 *    supplying a literal, and an object shaped like a reference is a client bug
 *    or an attempt to point the publish at some other step's output. Refusing it
 *    keeps "an edit is a literal" true.
 * 3. **The merged input must pass the plan's own validator.** See the module
 *    comment: this is the load-bearing rule, and it is why `validateToolInput`
 *    is exported from `./plan` rather than reimplemented.
 *
 * `fieldLimits` supplies per-field ceilings the spec does not know about — in
 * practice the target platform's character limit, which `compose_post` obeys when
 * it writes and `publish_post` has no reason to know. Passing it here means an
 * over-long edit is refused with "X allows 280 characters" instead of accepted
 * and then rejected by the platform after the person has already approved it.
 */
export function applyEdit(
  snapshot: Record<string, unknown>,
  edit: Readonly<Record<string, unknown>>,
  tool: ToolSpec,
  options: { fieldLimits?: Readonly<Record<string, number>> } = {},
): EditResult {
  const issues: string[] = [];
  const editable = new Set(editableFields(tool));
  const merged: Record<string, unknown> = { ...snapshot };
  const changed: string[] = [];

  for (const [name, value] of Object.entries(edit)) {
    if (!editable.has(name)) {
      issues.push(
        tool.fields.some((field) => field.name === name)
          ? `"${name}" is not something you can change before approving.`
          : `"${tool.name}" has no field called "${name}".`,
      );
      continue;
    }

    if (isStepRef(value)) {
      issues.push(`"${name}" must be plain text, not a reference to another step.`);
      continue;
    }

    const limit = options.fieldLimits?.[name];
    if (typeof value === "string" && limit !== undefined && value.length > limit) {
      issues.push(
        `"${name}" is ${value.length} characters; this platform allows ${limit}.`,
      );
      continue;
    }

    if (value !== snapshot[name]) changed.push(name);
    merged[name] = value;
  }

  if (issues.length > 0) return { ok: false, issues };

  // The same check a plan gets, on the same input, through the same code.
  const problems = validateToolInput(tool, merged);
  if (problems.length > 0) return { ok: false, issues: problems };

  return { ok: true, input: merged, changed };
}

// ---------------------------------------------------------------------------
// Policy targets
// ---------------------------------------------------------------------------

export const POLICY_SCOPES = ["account", "tool"] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

/**
 * What a user is allowed to write a policy about.
 *
 * - **account** — the key must be one of the user's own accounts. A policy on
 *   somebody else's account key is inert, and a typo is worse than inert: the
 *   user believes they disabled something and did not.
 * - **tool** — the name must be a tool, and that tool must have a side effect.
 *   "Require approval before `compose_post`" cannot be honoured: the text it
 *   writes does not exist yet, so the most the Runtime could do is approve a
 *   brief. Refusing it at write time is better than accepting a setting that
 *   silently does nothing.
 */
export function validatePolicyTarget(
  scope: PolicyScope,
  key: string,
  options: { accountKeys: readonly string[] },
): { ok: true } | { ok: false; reason: string } {
  if (scope === "account") {
    if (!options.accountKeys.includes(key)) {
      return {
        ok: false,
        reason: `"${key}" is not one of your accounts.`,
      };
    }
    return { ok: true };
  }

  const tool = getTool(key);
  if (!tool) {
    return { ok: false, reason: `"${key}" is not a tool.` };
  }
  if (!isApprovableTool(tool)) {
    return {
      ok: false,
      reason: `"${tool.name}" changes nothing outside Studio, so there is nothing to approve. Only ${approvableToolNames().join(
        ", ",
      )} can be gated.`,
    };
  }
  return { ok: true };
}

/** The tools a policy may name. */
export function approvableToolNames(): string[] {
  return toolCatalogue()
    .filter(isApprovableTool)
    .map((tool) => tool.name);
}
