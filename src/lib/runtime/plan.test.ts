import { describe, expect, it } from "vitest";

import type { CapabilityName } from "@/lib/connectors/types";

import {
  policyFor,
  validatePlan,
  type ExecutionPolicy,
  type PlanSpec,
  type RuntimeAccount,
} from "./plan";

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

const publish = (targetAccount: string) => ({
  label: `Publish to ${targetAccount}`,
  capability: "publish_post",
  targetAccount,
});

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

  it("rejects an empty plan without inventing a step", () => {
    const result = validatePlan({ plan: plan([]), accounts, capabilitiesFor });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toHaveLength(1);
    expect(!result.ok && result.issues[0].code).toBe("empty_step");
  });

  it("rejects a capability that does not exist", () => {
    const result = validatePlan({
      plan: plan([{ label: "Do a thing", capability: "launch_rocket" }]),
      accounts,
      capabilitiesFor,
    });
    expect(!result.ok && result.issues[0].code).toBe("unknown_capability");
  });

  it("rejects a publish step with no target account", () => {
    const result = validatePlan({
      plan: plan([{ label: "Publish somewhere", capability: "publish_post" }]),
      accounts,
      capabilitiesFor,
    });
    expect(!result.ok && result.issues[0].code).toBe("missing_target");
  });

  it("rejects an unknown account rather than silently dropping the step", () => {
    const result = validatePlan({
      plan: plan([publish("x:hilbras"), publish("x:ghost")]),
      accounts,
      capabilitiesFor,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toMatchObject({
      code: "unknown_account",
      stepIndex: 1,
    });
  });

  it("rejects a disabled account", () => {
    const result = validatePlan({
      plan: plan([publish("x:personal")]),
      accounts,
      capabilitiesFor,
    });
    expect(!result.ok && result.issues[0].code).toBe("account_disabled");
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
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues[0]).toMatchObject({
      code: "capability_unavailable",
      stepIndex: 1,
    });
  });

  it("reports every issue in one pass instead of the first", () => {
    const result = validatePlan({
      plan: plan([
        publish("x:personal"),
        { label: "Nope", capability: "launch_rocket" },
        publish("x:ghost"),
      ]),
      accounts,
      capabilitiesFor,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((i) => i.code)).toEqual([
      "account_disabled",
      "unknown_capability",
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
    expect(!blocked.ok && blocked.issues[0].code).toBe("policy_disabled");

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
      plan: plan([{ label: "Generate draft", capability: "create_post" }]),
      accounts,
      capabilitiesFor,
    });
    expect(result.ok).toBe(true);
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
