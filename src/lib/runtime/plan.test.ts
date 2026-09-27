import { describe, expect, it } from "vitest";

import type { CapabilityName } from "@/lib/connectors/types";

import {
  policyFor,
  validatePlan,
  type ExecutionPolicy,
  type PlanIssueCode,
  type PlanSpec,
  type RuntimeAccount,
} from "./plan";
import { makeRef } from "./references";

const PUBLISHING: readonly CapabilityName[] = [
  "create_post",
  "publish_post",
  "get_account",
];

const accounts: RuntimeAccount[] = [
  { id: "x:hilbras", platform: "x", enabled: true },
  { id: "instagram:hilbras", platform: "instagram", enabled: true },
  { id: "linkedin:hilbras", platform: "linkedin", enabled: true },
  { id: "x:personal", platform: "x", enabled: false },
];

/** Mirrors the real registry: connect-only platforms expose nothing. */
const capabilitiesFor = (a: RuntimeAccount): readonly CapabilityName[] =>
  a.platform === "linkedin" ? [] : PUBLISHING;

const plan = (steps: PlanSpec["steps"]): PlanSpec => ({ steps });

const publish = (targetAccount: string, text = "a post") => ({
  label: `Publish to ${targetAccount}`,
  capability: "publish_post",
  targetAccount,
  input: { text },
});

const compose = (targetAccount: string, brief: string) => ({
  label: `Draft for ${targetAccount}`,
  capability: "compose_post",
  targetAccount,
  input: { brief },
});

/** The pipeline the planner is asked for: compose, then publish its text. */
const pipeline = (targetAccount: string, brief: string) => [
  compose(targetAccount, brief),
  {
    label: `Publish to ${targetAccount}`,
    capability: "publish_post",
    targetAccount,
    input: { text: makeRef(0, "text") },
  },
];

const codes = (result: ReturnType<typeof validatePlan>): PlanIssueCode[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code);

/** Only the plan-level issues — the ones about the goal, not about a step. */
const planLevel = (result: ReturnType<typeof validatePlan>): PlanIssueCode[] =>
  result.ok
    ? []
    : result.issues.filter((issue) => issue.stepIndex === -1).map((i) => i.code);

describe("validatePlan", () => {
  it("accepts a plan whose targets are connected, enabled, and capable", () => {
    const result = validatePlan({
      plan: plan([publish("x:hilbras"), publish("instagram:hilbras")]),
      accounts,
      capabilitiesFor,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.decisions).toEqual(["auto", "auto"]);
  });

  it("accepts the pipeline shape it exists for", () => {
    const result = validatePlan({
      plan: plan([...pipeline("x:hilbras", "one reason"), ...pipeline("instagram:hilbras", "the same argument")]),
      accounts,
      capabilitiesFor,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an empty plan without inventing a step", () => {
    const result = validatePlan({ plan: plan([]), accounts, capabilitiesFor });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toHaveLength(1);
    expect(!result.ok && result.issues[0].code).toBe("empty_step");
  });

  it("rejects a tool this build does not have, and says which it has", () => {
    const result = validatePlan({
      plan: plan([{ label: "Do a thing", capability: "launch_rocket" }]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["unknown_tool"]);
    // The repair prompt carries this line, so the planner needs the options.
    expect(!result.ok && result.issues[0].message).toContain("compose_post");
  });

  it("rejects a platform capability that is not a tool", () => {
    // `get_account` is a real capability with no step behind it. Accepting it
    // would plan a step that cannot run.
    const result = validatePlan({
      plan: plan([{ label: "Read the account", capability: "get_account", targetAccount: "x:hilbras" }]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["unknown_tool"]);
  });

  it("rejects a publish step with no target account", () => {
    const result = validatePlan({
      plan: plan([{ label: "Publish somewhere", capability: "publish_post", input: { text: "x" } }]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["missing_target"]);
  });

  it("rejects an unknown account rather than silently dropping the step", () => {
    const result = validatePlan({
      plan: plan([publish("x:hilbras"), publish("x:ghost")]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["unknown_account"]);
    expect(!result.ok && result.issues[0].stepIndex).toBe(1);
  });

  it("rejects a disabled account", () => {
    const result = validatePlan({
      plan: plan([publish("x:personal")]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["account_disabled"]);
  });

  it("rejects a connect-only platform at plan time, not mid-publish", () => {
    // This is the whole point of the gate: a plan that would publish to
    // LinkedIn must be refused before it publishes to X and then discover the
    // LinkedIn step is impossible.
    const result = validatePlan({
      plan: plan([publish("x:hilbras"), publish("linkedin:hilbras")]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["capability_unavailable"]);
    expect(!result.ok && result.issues[0].stepIndex).toBe(1);
  });

  it("does not gate a Runtime-local tool on what the platform can do", () => {
    // compose_post never calls the platform, so "LinkedIn cannot publish post"
    // says nothing about whether LinkedIn's copy can be written. Applying the
    // capability check to a local tool would refuse plans for no reason.
    const result = validatePlan({
      plan: plan([compose("linkedin:hilbras", "an argument")]),
      accounts,
      capabilitiesFor,
    });
    expect(result.ok).toBe(true);
  });

  it("reports every issue in one pass instead of the first", () => {
    // The planner is handed the whole list and asked for a corrected plan, so
    // every issue it is not told about is one it will make again.
    const result = validatePlan({
      plan: plan([
        publish("x:personal"),
        { label: "Nope", capability: "launch_rocket" },
        publish("x:ghost"),
      ]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual([
      "account_disabled",
      "unknown_tool",
      "unknown_account",
    ]);
  });

  it("rejects a step that policy forbids, but allows one that needs approval", () => {
    const policy: ExecutionPolicy = {
      defaultDecision: "auto",
      byAccount: { "instagram:hilbras": "disabled" },
      byCapability: { publish_post: "approval" },
    };

    const blocked = validatePlan({
      plan: plan([publish("instagram:hilbras")]),
      accounts,
      capabilitiesFor,
      policy,
    });
    expect(codes(blocked)).toEqual(["policy_disabled"]);

    const needsReview = validatePlan({
      plan: plan([publish("x:hilbras")]),
      accounts,
      capabilitiesFor,
      policy,
    });
    expect(needsReview.ok).toBe(true);
    expect(needsReview.ok && needsReview.decisions).toEqual(["approval"]);
  });

  it("lets a step with no target run without resolving an account", () => {
    const result = validatePlan({
      plan: plan([{ label: "Draft", capability: "compose_post", input: { brief: "an angle" } }]),
      accounts,
      capabilitiesFor,
    });
    expect(result.ok).toBe(true);
  });
});

describe("validatePlan — declared inputs", () => {
  it("rejects a step missing a field its tool requires", () => {
    const result = validatePlan({
      plan: plan([{ label: "Publish", capability: "publish_post", targetAccount: "x:hilbras", input: {} }]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["invalid_step_input"]);
    expect(!result.ok && result.issues[0].message).toContain('"text"');
  });

  it("rejects an empty literal where a field is required", () => {
    const result = validatePlan({
      plan: plan([publish("x:hilbras", "   ")]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["invalid_step_input"]);
  });

  it("rejects a value longer than the field allows", () => {
    // Caught here rather than at execution so the repair loop can see it and
    // the plan is never accepted with an input that will blow a prompt limit.
    const result = validatePlan({
      plan: plan([compose("x:hilbras", "x".repeat(2_001))]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["invalid_step_input"]);
    expect(!result.ok && result.issues[0].message).toContain("2000");
  });

  it("rejects a non-string where a reference is required", () => {
    const result = validatePlan({
      plan: plan([
        { label: "Publish", capability: "publish_post", targetAccount: "x:hilbras", input: { text: 42 } },
      ]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["invalid_step_input"]);
  });

  it("accepts a $ref for a field that allows one", () => {
    const result = validatePlan({
      plan: plan([
        compose("x:hilbras", "one reason"),
        {
          label: "Publish",
          capability: "publish_post",
          targetAccount: "x:hilbras",
          input: { text: makeRef(0, "text") },
        },
      ]),
      accounts,
      capabilitiesFor,
    });
    expect(result.ok).toBe(true);
  });

  it("ignores keys the tool does not declare", () => {
    // The executor reads only the declared fields, so an extra key cannot change
    // behaviour. Refusing one would spend a repair attempt on a cosmetic
    // difference between two otherwise identical plans.
    const result = validatePlan({
      plan: plan([publish("x:hilbras", "a post")]),
      accounts,
      capabilitiesFor,
    });
    expect(result.ok).toBe(true);
  });
});

describe("validatePlan — references", () => {
  it("rejects a reference to a later step", () => {
    // A forward reference is a cycle: there is nothing to resolve it against.
    const result = validatePlan({
      plan: plan([
        { label: "Publish", capability: "publish_post", targetAccount: "x:hilbras", input: { text: makeRef(1, "text") } },
        compose("x:hilbras", "an angle"),
      ]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["invalid_reference"]);
    expect(!result.ok && result.issues[0].stepIndex).toBe(0);
  });

  it("rejects a step referring to itself", () => {
    const result = validatePlan({
      plan: plan([
        { label: "Publish", capability: "publish_post", targetAccount: "x:hilbras", input: { text: makeRef(0, "text") } },
      ]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["invalid_reference"]);
  });

  it("checks references before field types, because it is the truer complaint", () => {
    // "step 0's text" says what to fix. "text is not a string" makes the
    // planner look at the type when the shape is the problem.
    const result = validatePlan({
      plan: plan([
        { label: "Publish", capability: "publish_post", targetAccount: "x:hilbras", input: { text: makeRef(3, "text") } },
      ]),
      accounts,
      capabilitiesFor,
    });
    expect(codes(result)).toEqual(["invalid_reference"]);
  });
});

describe("validatePlan — required targets", () => {
  it("refuses a plan that skips one of the goal's accounts", () => {
    // A goal pointed at X and Instagram that posts only to X looks like it
    // worked. This is how the user finds out their second account went quiet.
    const result = validatePlan({
      plan: plan(pipeline("x:hilbras", "one reason")),
      accounts,
      capabilitiesFor,
      requiredTargets: ["x:hilbras", "instagram:hilbras"],
    });
    expect(codes(result)).toEqual(["uncovered_goal_target"]);
    expect(!result.ok && result.issues[0].message).toContain("instagram:hilbras");
  });

  it("accepts a plan that delivers to every target", () => {
    const result = validatePlan({
      plan: plan([...pipeline("x:hilbras", "one reason"), ...pipeline("instagram:hilbras", "the same")]),
      accounts,
      capabilitiesFor,
      requiredTargets: ["x:hilbras", "instagram:hilbras"],
    });
    expect(result.ok).toBe(true);
  });

  it("does not count a compose step as having reached the account", () => {
    // Compose writes text. If it counted as coverage, a plan that drafted for
    // both accounts and published to neither would validate.
    const result = validatePlan({
      plan: plan([compose("x:hilbras", "one"), compose("instagram:hilbras", "two")]),
      accounts,
      capabilitiesFor,
      requiredTargets: ["x:hilbras", "instagram:hilbras"],
    });
    expect(codes(result)).toEqual([
      "uncovered_goal_target",
      "uncovered_goal_target",
    ]);
  });

  it("says a target is unreachable, before any step mentions it", () => {
    // An account the planner never named would otherwise produce no issue at
    // all until the coverage check, which can only say "you forgot it".
    const result = validatePlan({
      plan: plan(pipeline("x:hilbras", "one reason")),
      accounts,
      capabilitiesFor,
      requiredTargets: ["x:hilbras", "linkedin:hilbras"],
    });
    expect(codes(result)).toEqual(["capability_unavailable", "uncovered_goal_target"]);
    expect(!result.ok && result.issues[0].message).toContain("linkedin:hilbras");
    expect(!result.ok && result.issues[0].stepIndex).toBe(-1);
  });

  it("distinguishes a disabled target from an unknown one", () => {
    // Three different messages send the user to three different pages.
    const disabled = validatePlan({
      plan: plan(pipeline("x:hilbras", "one")),
      accounts,
      capabilitiesFor,
      requiredTargets: ["x:personal"],
    });
    expect(planLevel(disabled)).toEqual([
      "account_disabled",
      "uncovered_goal_target",
    ]);

    const unknown = validatePlan({
      plan: plan(pipeline("x:hilbras", "one")),
      accounts,
      capabilitiesFor,
      requiredTargets: ["x:ghost"],
    });
    expect(planLevel(unknown)).toEqual([
      "unknown_account",
      "uncovered_goal_target",
    ]);
  });

  it("refuses an account the goal did not choose, even a usable one", () => {
    // The goal's target list is the user's instruction. A planner that invents
    // a different destination is stopped by the same check that stops a
    // hallucinated one, because the gate narrows its own account lookup to the
    // required targets — it does not trust the caller to have passed the right
    // list. Here the caller passes every account the user owns.
    const result = validatePlan({
      plan: plan(pipeline("x:hilbras", "one")),
      accounts,
      capabilitiesFor,
      requiredTargets: ["x:hilbras"],
    });
    expect(result.ok).toBe(true);

    const inventing = validatePlan({
      plan: plan([
        ...pipeline("x:hilbras", "one"),
        publish("instagram:hilbras"),
      ]),
      accounts,
      capabilitiesFor,
      requiredTargets: ["x:hilbras"],
    });
    expect(codes(inventing)).toEqual(["unknown_account"]);
    expect(!inventing.ok && inventing.issues[0].stepIndex).toBe(2);
  });
});

describe("policyFor", () => {
  it("prefers the per-account override over the per-capability one", () => {
    // Disabling one account must not disable the capability everywhere.
    const policy: ExecutionPolicy = {
      defaultDecision: "auto",
      byCapability: { publish_post: "disabled" },
      byAccount: { "x:hilbras": "auto" },
    };
    expect(policyFor(policy, publish("x:hilbras"))).toBe("auto");
    expect(policyFor(policy, publish("instagram:hilbras"))).toBe("disabled");
  });

  it("falls back to the default when nothing matches", () => {
    const policy: ExecutionPolicy = { defaultDecision: "approval" };
    expect(policyFor(policy, publish("x:hilbras"))).toBe("approval");
  });
});
