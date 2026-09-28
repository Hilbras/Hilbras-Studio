import { describe, expect, it } from "vitest";

import {
  APPROVAL_SOON_MS,
  APPROVAL_STATUS,
  EXECUTION_STATUS,
  GOAL_STATUS,
  STATUS_TABLES,
  approvalDeadlineView,
  approvalStatus,
  coverageIsExact,
  executionStatus,
  formatDuration,
  formatInstant,
  goalStatus,
  relativeTime,
  type StatusMeta,
  type Tone,
} from "./view";
import { APPROVAL_STATES, APPROVAL_WINDOW_MS, isOverdue } from "./approvals";
import { EXECUTION_STATES } from "./state";
import { GOAL_STATUSES } from "../goals/validation";

const TONES: readonly Tone[] = [
  "quiet",
  "neutral",
  "progress",
  "success",
  "warning",
  "danger",
];

/**
 * The one property the approval screen actually depends on.
 *
 * The screen shows a countdown; the server refuses answers. If those two use
 * different arithmetic they will eventually disagree at the boundary, and the
 * failure is a user who was told the door was open being refused by it. So this
 * is checked at the exact instant and either side of it, rather than trusting
 * that both call the same helper.
 */
describe("approvalDeadlineView", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");
  const deadline = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  it("agrees with the server at the exact deadline instant", () => {
    // The boundary, not a nearby moment: `isOverdue` is `>=`, so a millisecond
    // either side of it is where an off-by-one would show up.
    expect(approvalDeadlineView(deadline, now).overdue).toBe(
      isOverdue(deadline, now),
    );
    expect(
      approvalDeadlineView(deadline, new Date(deadline.getTime())).overdue,
    ).toBe(isOverdue(deadline, deadline));
    expect(
      approvalDeadlineView(
        deadline,
        new Date(deadline.getTime() - 1),
      ).overdue,
    ).toBe(isOverdue(deadline, new Date(deadline.getTime() - 1)));
  });

  it("agrees with the server at every millisecond near the boundary", () => {
    // A sweep, because a sampled test would only have caught an error of at
    // least one sample's width.
    for (let offset = -50; offset <= 50; offset++) {
      const at = new Date(deadline.getTime() + offset);
      expect(approvalDeadlineView(deadline, at).overdue).toBe(
        isOverdue(deadline, at),
      );
    }
  });

  it("agrees with the server across the whole window", () => {
    const created = new Date(now.getTime());
    const expiresAt = new Date(created.getTime() + APPROVAL_WINDOW_MS);
    for (let hour = 0; hour <= 24; hour++) {
      const at = new Date(created.getTime() + hour * 60 * 60 * 1000);
      expect(approvalDeadlineView(expiresAt, at).overdue).toBe(
        isOverdue(expiresAt, at),
      );
    }
  });

  it("never reports a closed window as closing soon", () => {
    // The two are contradictory, and a screen showing both talks a user into
    // pressing a button the server is about to refuse.
    for (let offset = -200; offset <= 200; offset += 7) {
      const at = new Date(deadline.getTime() + offset);
      const view = approvalDeadlineView(deadline, at);
      expect(view.overdue && view.soon).toBe(false);
    }
  });

  it("flags an open window inside the soon threshold", () => {
    const at = new Date(deadline.getTime() - APPROVAL_SOON_MS + 1000);
    const view = approvalDeadlineView(deadline, at);
    expect(view.overdue).toBe(false);
    expect(view.soon).toBe(true);
  });

  it("does not flag an open window outside the soon threshold", () => {
    const at = new Date(deadline.getTime() - APPROVAL_SOON_MS - 60_000);
    expect(approvalDeadlineView(deadline, at).soon).toBe(false);
  });

  it("floors the hours left rather than going negative", () => {
    // A countdown displaying a negative number is a visible bug; the question
    // it answers is whether the door is shut, which `overdue` answers.
    const longClosed = approvalDeadlineView(
      deadline,
      new Date(deadline.getTime() + 5 * 60 * 60 * 1000),
    );
    expect(longClosed.overdue).toBe(true);
    expect(longClosed.hoursLeft).toBe(0);
    expect(longClosed.label).toBe("closed 5h ago");
  });

  it("floors a partial hour down", () => {
    const at = new Date(deadline.getTime() - 90 * 60 * 1000);
    expect(approvalDeadlineView(deadline, at).hoursLeft).toBe(1);
  });

  it("labels an open window as closing and a closed one as closed", () => {
    expect(approvalDeadlineView(deadline, now).label).toBe("closes in 3h");
    expect(
      approvalDeadlineView(deadline, new Date(deadline.getTime() + 30_000)).label,
    ).toBe("closed 30s ago");
  });
});

describe("formatDuration", () => {
  it("picks the coarsest unit that still says something", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(59 * 60_000)).toBe("59m");
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(23 * 60 * 60_000)).toBe("23h");
    expect(formatDuration(24 * 60 * 60_000)).toBe("1d");
    expect(formatDuration(6 * 24 * 60 * 60_000)).toBe("6d");
    expect(formatDuration(7 * 24 * 60 * 60_000)).toBe("1w");
    expect(formatDuration(28 * 24 * 60 * 60_000)).toBe("4w");
    expect(formatDuration(35 * 24 * 60 * 60_000)).toBe("1mo");
    expect(formatDuration(400 * 24 * 60 * 60_000)).toBe("13mo");
  });

  it("clamps rather than rendering a negative duration", () => {
    expect(formatDuration(-5000)).toBe("0s");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");

  it("says which direction time is going", () => {
    // A goal's next firing is in the future and its last run is in the past,
    // so a one-directional formatter is wrong for half the things it renders.
    expect(relativeTime(new Date(now.getTime() + 4 * 60 * 60_000), now)).toBe(
      "in 4h",
    );
    expect(relativeTime(new Date(now.getTime() - 4 * 60 * 60_000), now)).toBe(
      "4h ago",
    );
  });

  it("says 'in 0s' at the present rather than claiming the past", () => {
    expect(relativeTime(now, now)).toBe("in 0s");
  });
});

describe("formatInstant", () => {
  it("renders a date and a time, because a relative span alone cannot be acted on", () => {
    const rendered = formatInstant(new Date("2026-09-28T14:20:00.000Z"));
    expect(rendered).toMatch(/2026/);
    expect(rendered.length).toBeGreaterThan(6);
  });
});

describe("the status tables", () => {
  it("cover exactly their vocabulary, with nothing missing and nothing extra", () => {
    for (const { states, table } of STATUS_TABLES) {
      expect(coverageIsExact(table, states)).toBe(true);
    }
  });

  it("cover exactly the real vocabularies, not copies of them", () => {
    // Stated against the modules the rest of the Runtime uses, so a state added
    // there cannot leave its table behind.
    expect(STATUS_TABLES[0].states).toBe(EXECUTION_STATES);
    expect(STATUS_TABLES[1].states).toBe(APPROVAL_STATES);
    expect(STATUS_TABLES[2].states).toBe(GOAL_STATUSES);
  });

  it("catch a renamed state left behind in a table", () => {
    // The half `Record<K, V>` does not check: an extra key still compiles.
    const retired: StatusMeta = { label: "Retired", tone: "quiet", meaning: "Gone." };
    const stale = { ...EXECUTION_STATUS, retired };
    expect(coverageIsExact(stale, EXECUTION_STATES)).toBe(false);
  });

  it("catch a missing key", () => {
    // Built by omission rather than destructuring, so the linter has no unused
    // binding to complain about and the intent — "a table with one state fewer"
    // — is in the construction.
    const short: Record<string, StatusMeta> = { ...EXECUTION_STATUS };
    delete short.running;
    expect(coverageIsExact(short, EXECUTION_STATES)).toBe(false);
  });

  it("give every state a label, a meaning, and a known tone", () => {
    for (const table of [EXECUTION_STATUS, APPROVAL_STATUS, GOAL_STATUS]) {
      for (const [state, meta] of Object.entries(table)) {
        expect(meta.label.length, state).toBeGreaterThan(0);
        expect(meta.meaning.length, state).toBeGreaterThan(0);
        expect(TONES, state).toContain(meta.tone);
        // A label with trailing punctuation is not a label.
        expect(meta.label.endsWith("."), state).toBe(false);
      }
    }
  });
});

describe("an unrecognised state", () => {
  it("renders as unknown rather than guessing", () => {
    // `state` is a text column, so a row written by a newer build is a real
    // case. Mapping an unknown value onto a known one would tell a user their
    // run failed when the build simply has no word for it.
    expect(executionStatus("retired").label).toBe("Unknown");
    expect(executionStatus("retired").tone).toBe("quiet");
    expect(approvalStatus("withdrawn").label).toBe("Unknown");
    expect(goalStatus("suspended").label).toBe("Unknown");
  });

  it("does not misreport an unknown state as a failure", () => {
    expect(executionStatus("retired").tone).not.toBe("danger");
  });

  it("still names every state the build does know", () => {
    for (const state of EXECUTION_STATES) {
      expect(executionStatus(state).label).not.toBe("Unknown");
    }
    for (const state of APPROVAL_STATES) {
      expect(approvalStatus(state).label).not.toBe("Unknown");
    }
    for (const state of GOAL_STATUSES) {
      expect(goalStatus(state).label).not.toBe("Unknown");
    }
  });
});

describe("the states a user must be able to tell apart", () => {
  it("distinguishes an open approval from a closed one", () => {
    // The whole point of the window: "waiting" must not look like "expired".
    expect(APPROVAL_STATUS.pending.tone).not.toBe(APPROVAL_STATUS.expired.tone);
    expect(APPROVAL_STATUS.approved.tone).not.toBe(APPROVAL_STATUS.rejected.tone);
  });

  it("distinguishes a rejected step from a failed one", () => {
    // A rejection is a person saying no to one step; a failure is the step
    // breaking. Collapsing them would make a deliberate choice look like a bug.
    expect(APPROVAL_STATUS.rejected.tone).not.toBe("danger");
    expect(EXECUTION_STATUS.failed.tone).toBe("danger");
  });

  it("says plainly that a suspended run is waiting on a person", () => {
    // "Needs you" rather than "Paused": a user who does not know they are the
    // one holding this up has no reason to open the approval screen.
    expect(EXECUTION_STATUS.awaiting_approval.label).toBe("Needs you");
    expect(EXECUTION_STATUS.awaiting_approval.meaning).toMatch(/approv/i);
  });

  it("distinguishes a goal that has never run from one that is mid-run", () => {
    expect(GOAL_STATUS.active.tone).toBe("success");
    expect(GOAL_STATUS.paused.tone).toBe("neutral");
  });
});
