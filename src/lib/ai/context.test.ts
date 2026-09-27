import { describe, expect, it } from "vitest";

import {
  describePlatformFor,
  renderPlannerContext,
  toPlannerAccount,
  type PlannerContext,
} from "./context";

const context: PlannerContext = {
  goalTitle: "Daily AI commentary",
  statement: "Post every morning about AI.",
  accounts: [
    toPlannerAccount({ id: "x:hilbras", platform: "x", handle: "hilbras" }),
    toPlannerAccount({ id: "instagram:hilbras", platform: "instagram", handle: "hilbras" }),
  ],
  history: [
    { slot: "2026-09-26T10:00Z", state: "completed", steps: 4 },
    { slot: "2026-09-25T10:00Z", state: "failed", steps: 2, failedTool: "publish_post" },
  ],
  repairNotes: [],
};

describe("describePlatformFor", () => {
  it("reports a known platform's limit and rules", () => {
    const described = describePlatformFor("x");
    expect(described.name).toBe("X");
    expect(described.maxTextLength).toBe(280);
    expect(described.rules.length).toBeGreaterThan(0);
  });

  it("gives an unknown platform the honest answer, not a guess", () => {
    // A limit invented for a platform this build does not know would be a
    // fabricated constraint, and the copy would be written against it.
    const described = describePlatformFor("myspace");
    expect(described.maxTextLength).toBeNull();
    expect(described.rules).toEqual([]);
  });
});

describe("toPlannerAccount", () => {
  it("carries the platform facts a post has to be written against", () => {
    const account = toPlannerAccount({
      id: "threads:hilbras",
      platform: "threads",
      handle: "hilbras",
    });
    expect(account.maxTextLength).toBe(500);
    expect(account.rules[0]).toContain("Conversational");
  });

  it("tolerates an account with no handle", () => {
    const account = toPlannerAccount({ id: "telegram:chat", platform: "telegram", handle: null });
    expect(account.handle).toBeNull();
    expect(account.name).toBe("Telegram");
  });
});

describe("renderPlannerContext", () => {
  it("includes the statement verbatim", () => {
    expect(renderPlannerContext(context)).toContain("Post every morning about AI.");
  });

  it("lists each account by the id a step must use", () => {
    const rendered = renderPlannerContext(context);
    expect(rendered).toContain("- id: x:hilbras");
    expect(rendered).toContain("- id: instagram:hilbras");
    expect(rendered).toContain("280 characters");
  });

  it("shows recent firings as outcomes, without their content", () => {
    const rendered = renderPlannerContext(context);
    expect(rendered).toContain("2026-09-26T10:00Z: completed (4 steps)");
    expect(rendered).toContain(
      "2026-09-25T10:00Z: failed (2 steps) — a step failed at publish_post",
    );
  });

  it("keeps the run's state and its failed step distinguishable", () => {
    // "pending at publish_post" reads as though `publish_post` were the state.
    // A run can be finished and still have a failed step in it, and the two
    // facts send the planner different directions.
    const rendered = renderPlannerContext({
      ...context,
      history: [
        { slot: "2026-09-27T10:00Z", state: "pending", steps: 1, failedTool: "publish_post" },
      ],
    });
    expect(rendered).toContain("pending (1 step) — a step failed at publish_post");
  });

  it("says so when there is no history, rather than showing an empty block", () => {
    const rendered = renderPlannerContext({ ...context, history: [] });
    expect(rendered).toContain("none yet");
  });

  it("omits the repair block entirely when nothing was refused", () => {
    expect(renderPlannerContext(context)).not.toContain(
      "why_the_last_plan_was_refused",
    );
  });

  it("includes the repair block with its notes when a plan was refused", () => {
    const rendered = renderPlannerContext({
      ...context,
      repairNotes: ["Step 0: no label."],
    });
    expect(rendered).toContain("why_the_last_plan_was_refused");
    expect(rendered).toContain("Step 0: no label.");
  });

  it("keeps the statement inside a block the prompt can delimit", () => {
    // The statement is the one place untrusted text enters the prompt. It has
    // to be separable from the instructions around it.
    const rendered = renderPlannerContext(context);
    expect(rendered).toContain("<statement>");
    expect(rendered).toContain("</statement>");
  });
});
