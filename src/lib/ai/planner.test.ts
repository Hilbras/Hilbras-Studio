import { describe, expect, it } from "vitest";

import { makeRef } from "@/lib/runtime/references";

import type { PlannerContext } from "./context";
import {
  buildPlannerSystemPrompt,
  coercePlan,
  extractJsonObject,
  MAX_PLAN_STEPS,
  proposePlan,
  repairNotesFor,
  type Completer,
} from "./planner";

/** A model reply the planner should accept. */
const planReply = (steps: unknown): string => JSON.stringify({ steps });

const ONE_STEP = [
  {
    label: "Draft for X",
    capability: "compose_post",
    targetAccount: "x:hilbras",
    input: { brief: "one reason weekly beats monthly" },
  },
];

/** A `Completer` that records what it was asked and returns fixed text. */
function stub(text: string): Completer & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  const complete = async (system: string, user: string) => {
    calls.push({ system, user });
    return text;
  };
  return Object.assign(complete, { calls });
}

const context: PlannerContext = {
  goalTitle: "Daily AI commentary",
  statement: "Post every morning about something in AI I found interesting.",
  accounts: [
    {
      id: "x:hilbras",
      platform: "x",
      name: "X",
      handle: "hilbras",
      maxTextLength: 280,
      rules: ["280 characters per post — long content must become a thread"],
    },
  ],
  history: [],
  repairNotes: [],
};

describe("buildPlannerSystemPrompt", () => {
  it("lists the real tool catalogue, not a description of it", () => {
    // The prompt is the only place the planner learns what it may use, so it
    // comes from the registry rather than from prose that can drift out of date.
    const system = buildPlannerSystemPrompt();
    expect(system).toContain("compose_post");
    expect(system).toContain("publish_post");
    expect(system).not.toContain("launch_rocket");
  });

  it("documents every declared field of every tool", () => {
    const system = buildPlannerSystemPrompt();
    for (const field of ["brief", "tone", "text", "mediaUrl"]) {
      expect(system).toContain(field);
    }
  });

  it("shows the reference syntax it expects", () => {
    expect(buildPlannerSystemPrompt()).toContain('"$ref"');
  });
});

describe("extractJsonObject", () => {
  it("reads a bare object", () => {
    expect(extractJsonObject('{"steps":[]}')).toBe('{"steps":[]}');
  });

  it("reads an object out of a fenced block", () => {
    expect(extractJsonObject('```json\n{"steps":[1]}\n```')).toBe('{"steps":[1]}');
    expect(extractJsonObject('```\n{"steps":[1]}\n```')).toBe('{"steps":[1]}');
  });

  it("reads an object after a line of preamble", () => {
    expect(
      extractJsonObject('Here is the plan:\n{"steps":[]}\nHope that helps!'),
    ).toBe('{"steps":[]}');
  });

  it("returns null when there is no object to read", () => {
    expect(extractJsonObject("I cannot do that")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("{ broken")).toBeNull();
  });

  it("refuses a plausible-looking object it cannot parse", () => {
    // Guessing where a model's JSON ended is how a truncated step becomes a
    // silently different plan. Failing is correct; the repair loop fixes it.
    const raw = '{"steps":[{"label":"a"}]} and then {"steps":[{"label":"b"}]}';
    expect(extractJsonObject(raw)).toBeNull();
  });
});

describe("coercePlan", () => {
  it("reads a well-formed plan", () => {
    const result = coercePlan(planReply(ONE_STEP));
    expect(result.ok).toBe(true);
    expect(result.ok && result.plan.steps).toHaveLength(1);
  });

  it("keeps a step's target and input, references included", () => {
    const result = coercePlan(
      planReply([
        {
          label: "Publish to X",
          capability: "publish_post",
          targetAccount: "x:hilbras",
          input: { text: makeRef(0, "text") },
        },
      ]),
    );
    expect(result.ok && result.plan.steps[0]).toEqual({
      label: "Publish to X",
      capability: "publish_post",
      targetAccount: "x:hilbras",
      input: { text: makeRef(0, "text") },
    });
  });

  it("refuses the whole reply when one step is malformed", () => {
    // Dropping the bad step and running the rest is how a plan for two accounts
    // posts to one of them and reports success.
    const result = coercePlan(
      planReply([
        { label: "Good", capability: "publish_post", targetAccount: "x:hilbras" },
        { label: "Bad", capability: 42 },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("Step 1");
  });

  it("names the problem precisely for each malformation", () => {
    const reasonFor = (steps: unknown) => {
      const result = coercePlan(planReply(steps));
      return result.ok ? null : result.reason;
    };

    expect(reasonFor([{ capability: "publish_post" }])).toContain("label");
    expect(reasonFor([{ label: "x" }])).toContain("tool name");
    expect(reasonFor([{ label: "x", capability: "y", targetAccount: 7 }])).toContain(
      "targetAccount",
    );
    expect(reasonFor([{ label: "x", capability: "y", input: "text" }])).toContain(
      "input",
    );
    expect(reasonFor(["not an object"])).toContain("not an object");
  });

  it("refuses a plan with no steps", () => {
    expect(coercePlan(planReply([]))).toEqual({
      ok: false,
      reason: "The plan has no steps.",
    });
  });

  it("refuses a reply with no steps array at all", () => {
    expect(!coercePlan('{"plan":[]}').ok).toBe(true);
  });

  it("refuses a plan longer than the ceiling rather than truncating it", () => {
    const steps = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({
      label: `Step ${i}`,
      capability: "publish_post",
      targetAccount: "x:hilbras",
    }));
    expect(!coercePlan(planReply(steps)).ok).toBe(true);
  });

  it("omits an absent target rather than writing an empty one", () => {
    const result = coercePlan(
      planReply([{ label: "Draft", capability: "compose_post", input: { brief: "x" } }]),
    );
    expect(result.ok && result.plan.steps[0].targetAccount).toBeUndefined();
  });

  it("treats an empty target string as no target", () => {
    const result = coercePlan(
      planReply([{ label: "Draft", capability: "compose_post", targetAccount: "" }]),
    );
    expect(result.ok && result.plan.steps[0].targetAccount).toBeUndefined();
  });

  it("refuses a reply that is not JSON at all", () => {
    const result = coercePlan("Sure! Here is what I would do: research, then post.");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("JSON");
  });
});

describe("proposePlan", () => {
  it("sends the goal and returns the plan", async () => {
    const complete = stub(planReply(ONE_STEP));
    const result = await proposePlan(context, complete);

    expect(result.ok).toBe(true);
    expect(complete.calls).toHaveLength(1);
    expect(complete.calls[0].user).toContain("Daily AI commentary");
    expect(complete.calls[0].user).toContain("x:hilbras");
  });

  it("passes the statement through verbatim", async () => {
    // The planner reads the user's own words. Reformatting them here would mean
    // interpreting before it has been asked to.
    const complete = stub(planReply(ONE_STEP));
    const statement = "Post every morning about AI.\n\n  Keep the spacing  and the tone.";
    await proposePlan({ ...context, statement }, complete);
    expect(complete.calls[0].user).toContain(statement);
  });

  it("includes repair notes when there are any, and the block only then", async () => {
    // Telling a planner "here is why that failed" when nothing has failed
    // invites it to invent a failure to fix.
    const complete = stub(planReply(ONE_STEP));
    await proposePlan(
      { ...context, repairNotes: ["Step 1: no label."] },
      complete,
    );
    expect(complete.calls[0].user).toContain("why_the_last_plan_was_refused");
    expect(complete.calls[0].user).toContain("Step 1: no label.");

    const first = stub(planReply(ONE_STEP));
    await proposePlan(context, first);
    expect(first.calls[0].user).not.toContain("why_the_last_plan_was_refused");
  });

  it("lets a model error propagate rather than reporting an empty plan", async () => {
    // The caller holds the budget and decides what a failure is worth; a
    // swallowed error here would arrive as "the model returned nothing usable".
    const complete: Completer = async () => {
      throw new Error("provider down");
    };
    await expect(proposePlan(context, complete)).rejects.toThrow("provider down");
  });
});

describe("repairNotesFor", () => {
  it("prefixes a step's issues with the step number and leaves plan-level ones alone", () => {
    expect(
      repairNotesFor([
        { code: "invalid_step_input", stepIndex: 2, message: '"publish_post" needs "text".' },
        { code: "uncovered_goal_target", stepIndex: -1, message: "The plan never delivers to x:hilbras." },
      ]),
    ).toEqual([
      'Step 2: "publish_post" needs "text".',
      "The plan never delivers to x:hilbras.",
    ]);
  });

  it("passes a validation message through unchanged", () => {
    // The issue text is the one part of this loop that has been reviewed;
    // rewriting it into something more directive can only lose information.
    const message = '"instagram:hilbras" cannot publish post.';
    expect(
      repairNotesFor([{ code: "capability_unavailable", stepIndex: 0, message }])[0],
    ).toBe(`Step 0: ${message}`);
  });
});
