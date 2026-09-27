import { describe, expect, it } from "vitest";

import {
  createSpendMeter,
  DEFAULT_SPEND_LIMITS,
  type SpendLimits,
} from "./limits";

const limits: SpendLimits = { perPlan: 2, perStep: 2, perRun: 5 };

describe("createSpendMeter", () => {
  it("allows calls inside every cap", () => {
    const meter = createSpendMeter(limits);
    expect(meter.takePlan().allowed).toBe(true);
    expect(meter.takeStep("a").allowed).toBe(true);
    expect(meter.takeStep("a").allowed).toBe(true);
    expect(meter.used).toBe(3);
    expect(meter.remaining()).toBe(2);
  });

  it("stops planning after the per-plan cap", () => {
    // Two means: propose once, repair once. A planner that cannot produce a
    // valid plan after being told what is wrong will not after being told
    // twice, and each attempt is a full prompt.
    const meter = createSpendMeter(limits);
    meter.takePlan();
    meter.takePlan();

    const third = meter.takePlan();
    expect(third.allowed).toBe(false);
    expect(third.allowed === false && third.scope).toBe("plan");
    expect(third.allowed === false && third.message).toContain("2");
    expect(meter.used).toBe(2);
  });

  it("counts the per-step cap separately for each step", () => {
    // One step exhausting its share must not starve the next one — that is how
    // a two-account goal loses its second post.
    const meter = createSpendMeter(limits);
    meter.takeStep("step-1");
    meter.takeStep("step-1");
    expect(meter.takeStep("step-1").allowed).toBe(false);
    expect(meter.takeStep("step-2").allowed).toBe(true);
    expect(meter.used).toBe(3);
  });

  it("names the step that ran out", () => {
    const meter = createSpendMeter(limits);
    meter.takeStep("step-7");
    meter.takeStep("step-7");
    const denied = meter.takeStep("step-7");
    expect(denied.allowed === false && denied.message).toContain("step-7");
    expect(denied.allowed === false && denied.scope).toBe("step");
  });

  it("treats the per-run cap as the ceiling the others are measured against", () => {
    // A plan with a hundred steps must not be able to spend a hundred calls.
    const meter = createSpendMeter({ perPlan: 99, perStep: 99, perRun: 3 });
    meter.takeStep("a");
    meter.takeStep("b");
    meter.takeStep("c");
    expect(meter.remaining()).toBe(0);

    const denied = meter.takeStep("d");
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.scope).toBe("run");
  });

  it("applies the run cap to planning as well as to steps", () => {
    const meter = createSpendMeter({ perPlan: 99, perStep: 99, perRun: 1 });
    expect(meter.takePlan().allowed).toBe(true);
    const denied = meter.takePlan();
    expect(denied.allowed === false && denied.scope).toBe("run");
  });

  it("keeps each meter independent", () => {
    // A meter is a per-run ceiling, not a ledger. Two goals firing at once must
    // not share an allowance, or one run's plan would starve the other's.
    const first = createSpendMeter({ perPlan: 1, perStep: 1, perRun: 1 });
    const second = createSpendMeter({ perPlan: 1, perStep: 1, perRun: 1 });

    expect(first.takePlan().allowed).toBe(true);
    expect(first.takePlan().allowed).toBe(false);
    expect(second.takePlan().allowed).toBe(true);
  });

  it("leaves the meter untouched when a call is refused", () => {
    const meter = createSpendMeter(limits);
    meter.takePlan();
    meter.takePlan();
    meter.takePlan();
    expect(meter.used).toBe(2);
  });
});

describe("DEFAULT_SPEND_LIMITS", () => {
  it("covers the flagship example with room for a length re-ask", () => {
    // X + Instagram, one compose and one publish each, is 2 planning + 2
    // compose. The per-step second call covers a character-limit violation on
    // both platforms, giving 6 — inside the 12 the run allows.
    const steps = 2 * DEFAULT_SPEND_LIMITS.perStep;
    const total = DEFAULT_SPEND_LIMITS.perPlan + steps;
    expect(total).toBeLessThanOrEqual(DEFAULT_SPEND_LIMITS.perRun);
  });

  it("is bounded", () => {
    expect(DEFAULT_SPEND_LIMITS.perPlan).toBeGreaterThan(0);
    expect(DEFAULT_SPEND_LIMITS.perStep).toBeGreaterThan(0);
    expect(DEFAULT_SPEND_LIMITS.perRun).toBeGreaterThan(0);
  });
});
