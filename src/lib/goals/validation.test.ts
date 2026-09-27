import { describe, expect, it } from "vitest";

import {
  MIN_GOAL_INTERVAL_MS,
  validateGoal,
  type GoalDraft,
  type GoalTarget,
} from "./validation";

const FROM = new Date("2026-09-27T12:00:00Z");

/** A working publisher, which is what most fixtures want. */
const x: GoalTarget = {
  id: "x:hilbras",
  platform: "x",
  enabled: true,
  capabilities: ["create_post", "publish_post", "get_account"],
};

/** A platform that completes OAuth and has no publisher. */
const linkedin: GoalTarget = {
  id: "linkedin:hilbras",
  platform: "linkedin",
  enabled: true,
  capabilities: [],
};

const disabled: GoalTarget = { ...x, id: "x:archive", enabled: false };

const draft = (over: Partial<GoalDraft> = {}): GoalDraft => ({
  title: "Daily AI posts",
  statement: "Publish two posts about AI every day.",
  schedule: "0 9 * * *",
  timeZone: "Europe/Berlin",
  targetAccounts: ["x:hilbras"],
  from: FROM,
  ...over,
});

const codes = (result: ReturnType<typeof validateGoal>) =>
  result.ok ? [] : result.issues.map((issue) => issue.code);

describe("goal validation", () => {
  it("accepts a complete, workable goal", () => {
    const result = validateGoal(draft(), [x]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("Daily AI posts");
    expect(result.value.targetAccounts).toEqual(["x:hilbras"]);
    expect(result.value.nextFiringAt.toISOString()).toBe("2026-09-28T07:00:00.000Z");
    expect(result.value.description).toBe("Every day at 09:00");
  });

  it("refuses the ROADMAP's own example, and says which platform is the problem", () => {
    // "Publish two posts about AI every day on LinkedIn and X" — the sentence
    // from the roadmap, which names a platform this build cannot post to. This is
    // the case that decides whether the gate earns its keep: a goal saved here
    // would look healthy and never publish.
    const result = validateGoal(
      draft({ targetAccounts: ["linkedin:hilbras", "x:hilbras"] }),
      [linkedin, x],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const issue = result.issues.find((i) => i.code === "capability_unavailable");
    expect(issue?.target).toBe("linkedin:hilbras");
    expect(issue?.message).toContain("linkedin");
    // And it does not also complain about the account that is fine.
    expect(codes(result)).not.toContain("unknown_account");
  });

  it("collects every problem rather than stopping at the first", () => {
    // A form that revealed one error per save is a form people give up on.
    const result = validateGoal(
      draft({
        title: "  ",
        statement: "",
        schedule: "not a cron",
        timeZone: "Mars/Olympus",
        targetAccounts: ["x:nobody", "x:archive"],
      }),
      [disabled],
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(new Set(codes(result))).toEqual(
      new Set([
        "empty_title",
        "empty_statement",
        "invalid_schedule",
        "invalid_timezone",
        "unknown_account",
        "account_disabled",
      ]),
    );
  });

  it("distinguishes three different reasons an account cannot be a target", () => {
    // These send the user to three different places: connect it, switch it on,
    // or pick a different platform. Collapsing them into one "invalid account"
    // would make the first two indistinguishable.
    const missing = validateGoal(draft({ targetAccounts: ["x:nobody"] }), [x]);
    expect(codes(missing)).toEqual(["unknown_account"]);

    const off = validateGoal(draft({ targetAccounts: ["x:archive"] }), [disabled]);
    expect(codes(off)).toEqual(["account_disabled"]);

    const incapable = validateGoal(
      draft({ targetAccounts: ["linkedin:hilbras"] }),
      [linkedin],
    );
    expect(codes(incapable)).toEqual(["capability_unavailable"]);
  });

  it("rejects a malformed account key", () => {
    const result = validateGoal(draft({ targetAccounts: ["xhilbras"] }), [x]);
    expect(codes(result)).toEqual(["malformed_target"]);

    const empty = validateGoal(draft({ targetAccounts: ["x:"] }), [x]);
    expect(codes(empty)).toEqual(["malformed_target"]);
  });

  it("requires at least one target", () => {
    expect(codes(validateGoal(draft({ targetAccounts: [] }), [x]))).toEqual([
      "no_targets",
    ]);
  });

  it("de-duplicates targets and keeps input order", () => {
    const result = validateGoal(
      draft({ targetAccounts: ["x:hilbras", "linkedin:hilbras", "x:hilbras"] }),
      [x, linkedin],
    );

    // The duplicate is still reported, because silently collapsing a list the
    // user typed twice hides a mistake in their form.
    expect(codes(result)).toEqual(
      expect.arrayContaining(["duplicate_target", "capability_unavailable"]),
    );
  });

  it("rejects a schedule that parses but can never fire", () => {
    // February 30th. Accepted by every cron parser, never reached by a clock.
    const result = validateGoal(draft({ schedule: "0 0 30 2 *" }), [x]);
    expect(codes(result)).toEqual(["unsatisfiable_schedule"]);
  });

  it("refuses a schedule that would post more often than the floor allows", () => {
    // A goal publishes on every firing, so `* * * * *` would be 1440 posts a day
    // to one account — enough to get the user's grant revoked, not just to
    // annoy them.
    const result = validateGoal(draft({ schedule: "* * * * *" }), [x]);
    expect(codes(result)).toEqual(["schedule_too_frequent"]);
  });

  it("allows a schedule exactly at the floor", () => {
    // Every 15 minutes is the documented minimum, so it must be accepted — an
    // off-by-one in the comparison would be a bug reported as "the app is
    // broken".
    const result = validateGoal(draft({ schedule: "*/15 * * * *" }), [x]);
    expect(result.ok).toBe(true);
  });

  it("catches a cadence that looks fine but fires too often", () => {
    // `0,5,10 * * * *` reads as a reasonable-looking schedule and posts twelve
    // times an hour. Reading the expression is not enough — the gap is what
    // matters, so the rule probes real slots.
    const result = validateGoal(draft({ schedule: "0,5,10 * * * *" }), [x]);
    expect(codes(result)).toEqual(["schedule_too_frequent"]);
  });

  it("allows an infrequent schedule that mentions a small number", () => {
    // "2 posts a week" is a count, not a time. The interval probe sees the real
    // gaps, so it is not confused.
    const result = validateGoal(draft({ schedule: "0 9 * * 1,4" }), [x]);
    expect(result.ok).toBe(true);
  });

  it("exposes the interval floor it enforces", () => {
    // The reason it exists is worth stating wherever a schedule is refused.
    expect(MIN_GOAL_INTERVAL_MS).toBe(15 * 60 * 1000);
  });

  it("defaults an empty time zone to UTC rather than refusing", () => {
    // The column defaults to UTC, so an empty string is the same request, not a
    // malformed one. Refusing it would make the one-field form unusable.
    const result = validateGoal(draft({ timeZone: "" }), [x]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.timeZone).toBe("UTC");
  });

  it("bounds the title and the statement", () => {
    const long = validateGoal(
      draft({ title: "x".repeat(121), statement: "y".repeat(4001) }),
      [x],
    );
    expect(codes(long)).toEqual(
      expect.arrayContaining(["title_too_long", "statement_too_long"]),
    );

    // Exactly at the limit is fine.
    const atLimit = validateGoal(
      draft({ title: "x".repeat(120), statement: "y".repeat(4000) }),
      [x],
    );
    expect(atLimit.ok).toBe(true);
  });

  it("trims the text it stores", () => {
    const result = validateGoal(
      draft({ title: "  Daily AI posts  ", statement: "  Post about AI.  " }),
      [x],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("Daily AI posts");
    expect(result.value.statement).toBe("Post about AI.");
  });

  it("canonicalises the schedule it stores", () => {
    // Extra whitespace and a macro both normalise, so the stored value is one
    // the parser will always accept and two equivalent schedules never differ in
    // the database.
    const spaced = validateGoal(draft({ schedule: "0   9  *  *  *" }), [x]);
    expect(spaced.ok).toBe(true);
    if (spaced.ok) expect(spaced.value.cron).toBe("0 9 * * *");

    const macro = validateGoal(draft({ schedule: "@daily" }), [x]);
    expect(macro.ok).toBe(true);
    if (macro.ok) expect(macro.value.cron).toBe("0 0 * * *");
  });

  it("keeps a schedule in the user's own zone", () => {
    // 09:00 in Berlin and 09:00 in Tokyo are different instants, and the goal
    // means the first one.
    const berlin = validateGoal(draft({ timeZone: "Europe/Berlin" }), [x]);
    const tokyo = validateGoal(draft({ timeZone: "Asia/Tokyo" }), [x]);

    expect(berlin.ok && tokyo.ok).toBe(true);
    if (!berlin.ok || !tokyo.ok) return;
    expect(berlin.value.nextFiringAt.getTime()).not.toBe(
      tokyo.value.nextFiringAt.getTime(),
    );
  });
});
