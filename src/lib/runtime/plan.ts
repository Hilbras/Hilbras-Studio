/**
 * Plan validation — the gate between "we have a plan" and "we may act".
 *
 * A generated plan is a proposal, not an instruction. It is produced from model
 * output and therefore untrusted until checked: it may name a capability that
 * does not exist, target an account the user has disabled, target a platform
 * with no publisher, or perform a side effect the user's policy forbids.
 *
 * All four are caught *here*, before the first step runs. The alternative is
 * discovering a bad target halfway through a multi-step plan, having already
 * published to the accounts that came before it — exactly the uncertain-outcome
 * situation ADR-005 is about, and far more expensive than refusing to start.
 *
 * This module is pure. It takes an account list and a capability resolver as
 * inputs rather than importing the connector registry or the database, so the
 * whole gate is testable without either.
 */

import { CAPABILITY_NAMES, type CapabilityName } from "@/lib/connectors/types";

type Capability = CapabilityName;

/** An account a plan may target, in the shape validation needs. */
export interface RuntimeAccount {
  /** `platform:handle`, e.g. "x:hilbras". */
  id: string;
  /** The platform this account lives on. */
  platform: string;
  /** A disabled account must never be a plan target. */
  enabled: boolean;
}

/** One step as proposed by a planner, before it is persisted. */
export interface StepSpec {
  label: string;
  capability: string;
  /** `platform:handle`. Required for any capability that acts on an account. */
  targetAccount?: string;
  input?: Record<string, unknown>;
}

/** A whole plan as proposed by a planner. */
export interface PlanSpec {
  steps: StepSpec[];
}

/** What a side-effecting capability is allowed to do without asking. */
export type PolicyDecision = "auto" | "approval" | "disabled";

/** The account ids that are permitted to auto-approve, and the global default. */
export interface ExecutionPolicy {
  defaultDecision: PolicyDecision;
  /** Per-account overrides, keyed by `platform:handle`. */
  byAccount?: Record<string, PolicyDecision>;
  /** Per-capability overrides, applied after the per-account override. */
  byCapability?: Record<string, PolicyDecision>;
}

/**
 * What a step will be allowed to do once the plan is accepted.
 *
 * Precedence is per-account over per-capability over the default: a user who
 * disables publishing for one noisy account means that account specifically,
 * not the capability everywhere.
 */
export function policyFor(
  policy: ExecutionPolicy,
  step: Pick<StepSpec, "capability" | "targetAccount">,
): PolicyDecision {
  if (step.targetAccount && policy.byAccount?.[step.targetAccount]) {
    return policy.byAccount[step.targetAccount];
  }
  if (policy.byCapability?.[step.capability]) {
    return policy.byCapability[step.capability];
  }
  return policy.defaultDecision;
}

export type PlanIssueCode =
  /** The plan has no steps, or a step is blank. */
  | "empty_step"
  /** `capability` is not one of the known capability names. */
  | "unknown_capability"
  /** The capability acts on an account but names none. */
  | "missing_target"
  /** The named account is not connected, or was never resolved. */
  | "unknown_account"
  /** The account exists but the user has disabled it. */
  | "account_disabled"
  /** The account's platform has no publisher for this capability. */
  | "capability_unavailable"
  /** Policy forbids the step outright. */
  | "policy_disabled";

export interface PlanIssue {
  code: PlanIssueCode;
  /** Index of the offending step, or -1 for plan-level issues. */
  stepIndex: number;
  message: string;
}

export interface PlanValidationInput {
  plan: PlanSpec;
  accounts: readonly RuntimeAccount[];
  /**
   * Capabilities available for an account. Injected rather than imported so
   * this module stays free of the connector registry — and so a Phase 3
   * connector can narrow an account's set without touching the gate.
   */
  capabilitiesFor: (account: RuntimeAccount) => readonly CapabilityName[];
  policy?: ExecutionPolicy;
}

export type PlanValidation =
  | {
      ok: true;
      /** Execution decisions, one per step, aligned by index. */
      decisions: PolicyDecision[];
    }
  | { ok: false; issues: PlanIssue[] };

/** Capabilities that must name a target account to be meaningful. */
const NEEDS_TARGET: ReadonlySet<Capability> = new Set([
  "publish_post",
  "get_posts",
  "delete_post",
]);

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(CAPABILITY_NAMES);

/**
 * Decide whether a plan may run.
 *
 * Collects *every* issue rather than failing on the first, so a user fixing a
 * plan sees the whole list instead of rediscovering one problem per attempt.
 */
export function validatePlan(input: PlanValidationInput): PlanValidation {
  const { plan, accounts, capabilitiesFor } = input;
  const policy: ExecutionPolicy = input.policy ?? { defaultDecision: "auto" };

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const issues: PlanIssue[] = [];
  const decisions: PolicyDecision[] = [];

  if (plan.steps.length === 0) {
    return {
      ok: false,
      issues: [
        {
          code: "empty_step",
          stepIndex: -1,
          message: "The plan has no steps.",
        },
      ],
    };
  }

  plan.steps.forEach((step, stepIndex) => {
    if (!step.label?.trim() || !step.capability?.trim()) {
      issues.push({
        code: "empty_step",
        stepIndex,
        message: "Every step needs a label and a capability.",
      });
      decisions.push("disabled");
      return;
    }

    if (!KNOWN_CAPABILITIES.has(step.capability)) {
      issues.push({
        code: "unknown_capability",
        stepIndex,
        message: `"${step.capability}" is not a known capability.`,
      });
      decisions.push("disabled");
      return;
    }

    const capability = step.capability as Capability;
    const needsTarget = NEEDS_TARGET.has(capability);

    if (needsTarget && !step.targetAccount) {
      issues.push({
        code: "missing_target",
        stepIndex,
        message: `"${capability}" acts on an account, so the step must name one.`,
      });
      decisions.push("disabled");
      return;
    }

    // A step with no target (e.g. a local "generate draft" step) is not gated on
    // account availability — there is nothing to resolve.
    if (step.targetAccount) {
      const account = byId.get(step.targetAccount);
      if (!account) {
        issues.push({
          code: "unknown_account",
          stepIndex,
          message: `No connected account matches "${step.targetAccount}".`,
        });
        decisions.push("disabled");
        return;
      }
      if (!account.enabled) {
        issues.push({
          code: "account_disabled",
          stepIndex,
          message: `Account "${account.id}" is disabled.`,
        });
        decisions.push("disabled");
        return;
      }
      if (!capabilitiesFor(account).includes(capability)) {
        issues.push({
          code: "capability_unavailable",
          stepIndex,
          message: `"${account.platform}" cannot ${capability}.`,
        });
        decisions.push("disabled");
        return;
      }
    }

    const decision = policyFor(policy, step);
    if (decision === "disabled") {
      issues.push({
        code: "policy_disabled",
        stepIndex,
        message: `Policy does not allow "${capability}"${
          step.targetAccount ? ` on ${step.targetAccount}` : ""
        }.`,
      });
    }
    decisions.push(decision);
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, decisions };
}

