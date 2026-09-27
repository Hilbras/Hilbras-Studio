/**
 * Plan validation — the gate between "we have a plan" and "we may act".
 *
 * A generated plan is a proposal, not an instruction. It is produced from model
 * output and therefore untrusted until checked: it may name a tool that does not
 * exist, target an account the user has not chosen for this goal, target a
 * platform with no publisher, resolve an input from a step that runs later, or
 * perform a side effect the user's policy forbids.
 *
 * All six are caught *here*, before the first step runs. The alternative is
 * discovering a bad plan halfway through, having already published to the
 * accounts that came before it — exactly the uncertain-outcome situation
 * ADR-005 is about, and far more expensive than refusing to start.
 *
 * This module is pure. It takes an account list and a capability resolver as
 * inputs rather than importing the connector registry or the database, so the
 * whole gate is testable without either.
 *
 * ## Two things are checked that are not about individual steps
 *
 * **Every account is reachable.** `requiredTargets` is the goal's own target
 * list, and a plan that delivers to only some of them is refused. A goal
 * pointed at X and Instagram that quietly posts to X is a plan that looks like
 * it worked. The alternative — let the plan run and note the omission — is how a
 * user ends up with half their accounts going quiet for months.
 *
 * **The account list is the goal's, not the user's.** The caller passes the
 * goal's targets, not every account the user owns. So an account that is
 * connected and capable but was not chosen for this goal reads as
 * `unknown_account` here. That is deliberate: the goal's target list is the
 * user's instruction, and a planner that invents a different destination is
 * stopped by the same check that stops a hallucinated one.
 */

import type { CapabilityName } from "@/lib/connectors/types";

import { collectRefs, isStepRef } from "./references";
import {
  deliveryCapability,
  getTool,
  TOOL_NAMES,
  type ToolField,
  type ToolSpec,
} from "./tools";

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
  /**
   * A tool name — not necessarily a platform capability. See `./tools` for why
   * the two namespaces are separate.
   */
  capability: string;
  /** `platform:handle`. Required for any tool that needs a target. */
  targetAccount?: string;
  input?: Record<string, unknown>;
}

/** A whole plan as proposed by a planner. */
export interface PlanSpec {
  steps: StepSpec[];
}

/** What a side-effecting tool is allowed to do without asking. */
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
  /** The step names a tool this build does not have. */
  | "unknown_tool"
  /** A tool that needs an account was given none. */
  | "missing_target"
  /** The named account is not among the ones this plan may use. */
  | "unknown_account"
  /** The account exists but the user has disabled it. */
  | "account_disabled"
  /** The account's platform cannot do what the tool needs. */
  | "capability_unavailable"
  /** Policy forbids the step outright. */
  | "policy_disabled"
  /** A declared input is missing, or is not the kind of value it must be. */
  | "invalid_step_input"
  /**
   * A `$ref` points forward or at the step itself.
   *
   * A plan's inputs may only come from steps that already ran. A forward
   * reference is a cycle, and there is nothing to resolve it against.
   */
  | "invalid_reference"
  /** The plan delivers to none of the accounts this goal targets. */
  | "uncovered_goal_target";

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
   * this module stays free of the connector registry — and so a connector can
   * narrow an account's set without touching the gate.
   */
  capabilitiesFor: (account: RuntimeAccount) => readonly CapabilityName[];
  policy?: ExecutionPolicy;
  /**
   * Accounts this goal targets. Every one must be delivered to, and none
   * outside this list may be.
   */
  requiredTargets?: readonly string[];
}

export type PlanValidation =
  | {
      ok: true;
      /** Execution decisions, one per step, aligned by index. */
      decisions: PolicyDecision[];
    }
  | { ok: false; issues: PlanIssue[] };

/**
 * Check one declared input field, or explain why it is not acceptable.
 *
 * Returns `null` for a field that is fine or absent-and-optional, so the
 * caller can collect every problem in the step rather than stopping at the
 * first. Unknown keys in `input` are ignored rather than refused: the executor
 * reads only the fields the tool declares, so an extra key cannot change what
 * happens, and rejecting one would spend a repair attempt on a cosmetic
 * difference between two otherwise identical plans.
 */
function checkField(
  tool: ToolSpec,
  field: ToolField,
  input: Record<string, unknown> | undefined,
): string | null {
  const value = input?.[field.name];

  if (value === undefined) {
    return field.required
      ? `"${tool.name}" needs "${field.name}".`
      : null;
  }

  if (isStepRef(value)) return null;

  if (field.type === "ref") {
    return `"${field.name}" must be a $ref to an earlier step's result.`;
  }

  if (typeof value !== "string" || value.trim() === "") {
    return `"${field.name}" must be non-empty text${
      field.type === "string_or_ref" ? " or a $ref to an earlier step" : ""
    }.`;
  }

  if (field.maxChars !== undefined && value.length > field.maxChars) {
    return `"${field.name}" is ${value.length} characters; the limit is ${field.maxChars}.`;
  }

  return null;
}

const KNOWN_TOOLS: ReadonlySet<string> = new Set(TOOL_NAMES);

/**
 * Decide whether a plan may run.
 *
 * Collects *every* issue rather than failing on the first, so a user fixing a
 * plan sees the whole list instead of rediscovering one problem per attempt.
 * That matters more here than anywhere else in the system: the planner is
 * handed this list and asked for a corrected plan, so every issue it is not
 * told about is one it will make again.
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

  // When the caller names the goal's targets, they are also the *only* accounts
  // a step may use. Narrowing the lookup here rather than trusting the caller to
  // have passed the right list is the point: a call site that passed every
  // account the user owns would otherwise accept a plan that publishes to an
  // account this goal was never pointed at. A convention nobody is forced to
  // follow is not a gate.
  const usable = input.requiredTargets
    ? new Set(input.requiredTargets)
    : null;
  const known = (id: string): RuntimeAccount | undefined => {
    if (usable && !usable.has(id)) return undefined;
    return byId.get(id);
  };

  // Whether each account a plan names can actually receive a delivery. Checked
  // for the goal's own targets up front, so "LinkedIn cannot publish" is said
  // once and plainly rather than inferred from a step that never appeared.
  const delivery = deliveryCapability();
  if (input.requiredTargets) {
    for (const target of input.requiredTargets) {
      const problem = describeUnreachableTarget(target, known, capabilitiesFor, delivery);
      if (problem) issues.push({ ...problem, stepIndex: -1 });
    }
  }

  plan.steps.forEach((step, stepIndex) => {
    if (!step.label?.trim() || !step.capability?.trim()) {
      issues.push({
        code: "empty_step",
        stepIndex,
        message: "Every step needs a label and a tool.",
      });
      decisions.push("disabled");
      return;
    }

    if (!KNOWN_TOOLS.has(step.capability)) {
      issues.push({
        code: "unknown_tool",
        stepIndex,
        message: `"${step.capability}" is not a tool. Use one of: ${TOOL_NAMES.join(", ")}.`,
      });
      decisions.push("disabled");
      return;
    }

    const tool = getTool(step.capability) as ToolSpec;

    if (tool.needsTarget && !step.targetAccount) {
      issues.push({
        code: "missing_target",
        stepIndex,
        message: `"${tool.name}" acts on an account, so the step must name one.`,
      });
      decisions.push("disabled");
      return;
    }

    // A step whose inputs come from steps that have not run yet cannot run.
    // Checked before the fields, because "step 3's text" is a truer complaint
    // than "text is not a string".
    const forwardRefs = collectRefs(step.input).filter(
      (ref) => ref.step >= stepIndex,
    );
    if (forwardRefs.length > 0) {
      issues.push({
        code: "invalid_reference",
        stepIndex,
        message: `A step may only use results from steps before it, but step ${stepIndex} refers to step ${forwardRefs[0].step}.`,
      });
      decisions.push("disabled");
      return;
    }

    const inputProblems = tool.fields
      .map((field) => checkField(tool, field, step.input))
      .filter((problem): problem is string => problem !== null);
    if (inputProblems.length > 0) {
      for (const message of inputProblems) {
        issues.push({ code: "invalid_step_input", stepIndex, message });
      }
      decisions.push("disabled");
      return;
    }

    // A step with no target (a local tool the planner left untargeted) is not
    // gated on account availability — there is nothing to resolve.
    if (step.targetAccount) {
      const account = known(step.targetAccount);
      if (!account) {
        issues.push({
          code: "unknown_account",
          stepIndex,
          message: `No usable account matches "${step.targetAccount}".`,
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
      // Only a tool that delegates to a platform has a capability to be missing.
      // A Runtime-local tool is not limited by what the account's platform can
      // do — it never calls the platform.
      if (tool.capability && !capabilitiesFor(account).includes(tool.capability)) {
        issues.push({
          code: "capability_unavailable",
          stepIndex,
          message: `"${account.platform}" cannot ${tool.capability}.`,
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
        message: `Policy does not allow "${tool.name}"${
          step.targetAccount ? ` on ${step.targetAccount}` : ""
        }.`,
      });
    }
    decisions.push(decision);
  });

  if (input.requiredTargets && delivery) {
    const delivered = new Set(
      plan.steps
        .filter((step) => {
          const tool = getTool(step.capability);
          return tool?.deliversToAccount && step.targetAccount;
        })
        .map((step) => step.targetAccount as string),
    );
    for (const target of input.requiredTargets) {
      if (!delivered.has(target)) {
        issues.push({
          code: "uncovered_goal_target",
          stepIndex: -1,
          message: `The plan never delivers to "${target}", which this goal targets.`,
        });
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, decisions };
}

/**
 * Why a goal target cannot receive a delivery, or `null` if it can.
 *
 * Distinct from the per-step checks because it runs against the goal's target
 * list rather than against a step that exists — an account the planner never
 * mentioned would otherwise produce no issue at all until the coverage check,
 * which can only say "you forgot it" and not "it cannot work".
 */
function describeUnreachableTarget(
  target: string,
  known: (id: string) => RuntimeAccount | undefined,
  capabilitiesFor: (account: RuntimeAccount) => readonly CapabilityName[],
  delivery: CapabilityName | null,
): Omit<PlanIssue, "stepIndex"> | null {
  const account = known(target);
  if (!account) {
    return {
      code: "unknown_account",
      message: `This goal targets "${target}", which is not a usable account.`,
    };
  }
  if (!account.enabled) {
    return {
      code: "account_disabled",
      message: `This goal targets "${account.id}", which is disabled.`,
    };
  }
  if (delivery && !capabilitiesFor(account).includes(delivery)) {
    return {
      code: "capability_unavailable",
      message: `This goal targets "${account.id}", but "${account.platform}" cannot ${delivery}.`,
    };
  }
  return null;
}
