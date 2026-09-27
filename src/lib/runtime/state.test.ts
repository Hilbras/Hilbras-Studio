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
    reject: "cancelled",
    approval_timeout: "failed",
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

  it("lets a suspended run resume, and treats rejection as a cancellation", () => {
    // Rejection is not a failure: nothing went wrong, the user said no.
    expect(transition("awaiting_approval", { type: "approve" })).toEqual({
      ok: true,
      from: "awaiting_approval",
      to: "running",
    });
    expect(transition("awaiting_approval", { type: "reject" })).toEqual({
      ok: true,
      from: "awaiting_approval",
      to: "cancelled",
    });
    expect(transition("awaiting_approval", { type: "approval_timeout" })).toEqual({
      ok: true,
      from: "awaiting_approval",
      to: "failed",
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
