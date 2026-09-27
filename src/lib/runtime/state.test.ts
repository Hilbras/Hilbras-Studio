import { describe, expect, it } from "vitest";

import {
  canTransition,
  EXECUTION_STATES,
  isSuspended,
  isTerminal,
  shouldRetry,
  transition,
  type ExecutionEvent,
  type ExecutionState,
} from "./state";

const ALL_EVENTS: ExecutionEvent[] = [
  { type: "start" },
  { type: "succeed" },
  { type: "fail" },
  { type: "request_approval" },
  { type: "approve" },
  { type: "reject" },
  { type: "approval_timeout" },
  { type: "cancel" },
];

/** The table under test, written out independently of the implementation. */
const EXPECTED: Record<ExecutionState, Partial<Record<string, ExecutionState>>> = {
  pending: { start: "running", cancel: "cancelled" },
  running: {
    succeed: "completed",
    fail: "failed",
    request_approval: "awaiting_approval",
    cancel: "cancelled",
  },
  awaiting_approval: {
    approve: "running",
    reject: "running",
    approval_timeout: "running",
    cancel: "cancelled",
  },
  completed: {},
  failed: {},
  cancelled: {},
};

describe("execution state machine", () => {
  it("matches the specified table for every state and event", () => {
    // Exhaustive by construction: if a state or event is added, this fails until
    // the expected table is updated, which is the point.
    for (const from of EXECUTION_STATES) {
      for (const event of ALL_EVENTS) {
        const want = EXPECTED[from][event.type];
        const got = transition(from, event);
        if (want) {
          expect(got, `${from} + ${event.type}`).toEqual({
            ok: true,
            from,
            to: want,
          });
        } else {
          expect(got, `${from} + ${event.type}`).toEqual({
            ok: false,
            from,
            reason: "illegal_transition",
          });
        }
      }
    }
  });

  it("keeps terminal states terminal", () => {
    for (const state of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminal(state)).toBe(true);
      for (const event of ALL_EVENTS) {
        expect(canTransition(state, event), `${state} + ${event.type}`).toBe(
          false,
        );
      }
    }
  });

  it("treats a pending approval as suspended, not in progress", () => {
    // This is what keeps a waiting run from being reclaimed as a stale lease or
    // reported as actively executing.
    expect(isSuspended("awaiting_approval")).toBe(true);
    expect(isSuspended("running")).toBe(false);
    expect(isSuspended("pending")).toBe(false);
    expect(isTerminal("awaiting_approval")).toBe(false);
  });

  it("resumes the run on every decision, because the run was never the question", () => {
    // All three lead back to `running`, and that is the change from v0.3.0.
    //
    // What was waiting was one step. A person answering "no" to the X post has
    // not said anything about the Instagram post, and the rule from v0.5.0 is
    // that each target settles independently — so a rejection that cancelled the
    // run would make the one failure a human caused behave differently from
    // every other failure, and the user would have to learn that separately.
    // v0.3.0's `reject → cancelled` and `approval_timeout → failed` are corrected
    // here; the difference is recorded on the step, not on the run.
    for (const type of ["approve", "reject", "approval_timeout"] as const) {
      expect(transition("awaiting_approval", { type })).toEqual({
        ok: true,
        from: "awaiting_approval",
        to: "running",
      });
    }
  });

  it("still lets a user stop a suspended run outright", () => {
    // Resuming on a decision is not the same as being unable to stop. `cancel`
    // remains, and it is the one decision that ends the run.
    expect(transition("awaiting_approval", { type: "cancel" })).toEqual({
      ok: true,
      from: "awaiting_approval",
      to: "cancelled",
    });
  });

  it("cannot skip straight to completed or resurrect a finished run", () => {
    expect(canTransition("pending", { type: "succeed" })).toBe(false);
    expect(canTransition("failed", { type: "start" })).toBe(false);
    expect(canTransition("cancelled", { type: "start" })).toBe(false);
  });

  it("cancels from any non-terminal state, and only those", () => {
    for (const state of EXECUTION_STATES) {
      // `failed` is terminal too — an exhausted run is not "cancelled", it
      // failed. Cancelling it would erase why it stopped.
      const cancellable = !isTerminal(state) && state !== "cancelled";
      expect(canTransition(state, { type: "cancel" }), state).toBe(
        cancellable,
      );
    }
  });
});

describe("shouldRetry", () => {
  it("permits another attempt only for a failed run with a retryable cause", () => {
    expect(shouldRetry("failed", { code: "rate_limited", retryable: true })).toBe(
      true,
    );
    expect(shouldRetry("failed", { code: "expired", retryable: false })).toBe(
      false,
    );
  });

  it("never retries a run that is not failed", () => {
    // A succeeded run must not be re-executed just because its last step
    // reported a retryable error.
    for (const state of EXECUTION_STATES) {
      if (state === "failed") continue;
      expect(
        shouldRetry(state, { code: "rate_limited", retryable: true }),
        state,
      ).toBe(false);
    }
  });
});
