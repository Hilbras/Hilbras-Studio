/**
 * Runtime execution state.
 *
 * This module is pure: no database, no queue, no platform. The Runtime's
 * correctness rests on this file, and it is the one part of the Runtime that
 * can be exhaustively tested without standing up Postgres or Inngest — so the
 * rules live here rather than being scattered through the executor.
 *
 * Two properties are load-bearing:
 *
 * 1. **Server-authoritative (ADR-003).** A transition is a function of the
 *    current state and an event. Nothing else may write state, and no AI output
 *    or tool argument can name a destination state — it can only raise an event.
 *
 * 2. **Suspension is not a terminal state.** A run waiting for a human approval
 *    holds no lease and consumes no budget, so it must be able to resume. It
 *    must equally not look "in progress" to the lease logic, which is why
 *    `awaiting_approval` is modelled as its own state rather than a flavour of
 *    `running`.
 *
 * ## A decision suspends; it does not conclude
 *
 * `approve`, `reject`, and `approval_timeout` all lead back to `running`. The
 * three are separate events because three different things happened, and the
 * run's history has to say which. The destination is the same because the run's
 * fate was never in question — one step was waiting, and now it is not.
 *
 * v0.3.0 shipped `reject → cancelled` and `approval_timeout → failed`. Both
 * changed in v0.8.0, and the reason is the same: they made a human decision
 * about *one step* decide the fate of *every other step*. A goal pointed at X
 * and Instagram whose X post is rejected should still post to Instagram, which
 * is the settle-independently rule v0.5.0 already applies to every other kind of
 * step failure. See `./approvals` for where each decision is recorded.
 */

/** Every state a Run or a Step can occupy. */
export const EXECUTION_STATES = [
  "pending",
  "running",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

/**
 * States a run can never leave.
 *
 * A retry does not revive a `failed` run. The queue re-invokes the executor,
 * which starts a **new attempt** — that is what keeps "attempt" monotonic and
 * makes an at-least-once queue safe to reason about (ADR-005).
 */
export const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/**
 * States in which the run is neither finished nor holding a lease.
 *
 * The scheduler's claim logic and the run-timeout sweep both key off this: a
 * suspended run must not be reclaimed as stale, and must not be reported as
 * actively executing.
 */
export const SUSPENDED_STATES: ReadonlySet<ExecutionState> = new Set([
  "awaiting_approval",
]);

export function isTerminal(state: ExecutionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isSuspended(state: ExecutionState): boolean {
  return SUSPENDED_STATES.has(state);
}

/** Why a run is changing state. The event, not the destination. */
export type ExecutionEvent =
  | { type: "start" }
  | { type: "succeed" }
  /** Terminal for this attempt. Whether another is allowed is `shouldRetry`. */
  | { type: "fail" }
  /** A side-effecting step needs a human decision. */
  | { type: "request_approval" }
  /** The human approved, or the timeout policy resolved to auto-approve. */
  | { type: "approve" }
  /** The human rejected. Distinct from `fail`: nothing went wrong. */
  | { type: "reject" }
  /** The approval window elapsed without a decision. */
  | { type: "approval_timeout" }
  | { type: "cancel" };

/** The full transition table. Nothing outside it is legal. */
const TRANSITIONS: Readonly<
  Record<ExecutionState, Partial<Record<ExecutionEvent["type"], ExecutionState>>>
> = {
  pending: {
    start: "running",
    cancel: "cancelled",
  },
  running: {
    succeed: "completed",
    fail: "failed",
    request_approval: "awaiting_approval",
    cancel: "cancelled",
  },
  // All three decisions resume the run. They are three distinct *events* because
  // a decision is distinct — an approval that was edited and one that was
  // rejected are different facts, and the run's history records which happened.
  // But the run's fate is not decided here: what differed was the fate of the
  // one step that was waiting, and the run settles from its step outcomes the
  // same way it does for any other failure.
  //
  // A rejection therefore does *not* cancel the run. The rule from v0.5.0 is
  // that each target settles independently — a goal pointed at X and Instagram
  // should still publish to the one the user did not object to. Treating a human
  // "no" as a cancellation would make the one failure a user caused behave
  // differently from every other failure, and the user would have to learn that
  // rule separately.
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

export type TransitionResult =
  | { ok: true; from: ExecutionState; to: ExecutionState }
  | { ok: false; from: ExecutionState; reason: "illegal_transition" };

/**
 * Apply an event.
 *
 * Returns the next state rather than mutating, so the caller persists it inside
 * the same transaction that performs the side effect. A no-op is an error, not
 * a silent success: an event that does not apply means the caller's view of the
 * run is stale, and quietly ignoring that would hide a lost update.
 */
export function transition(
  from: ExecutionState,
  event: ExecutionEvent,
): TransitionResult {
  const to = TRANSITIONS[from][event.type];
  if (!to) return { ok: false, from, reason: "illegal_transition" };

  return { ok: true, from, to };
}

export function canTransition(
  from: ExecutionState,
  event: ExecutionEvent,
): boolean {
  return transition(from, event).ok;
}

/**
 * Whether a failed run may be retried.
 *
 * Only the executor consults this, and only to decide whether to let the queue
 * schedule another attempt. A run that failed for a reason needing a human —
 * an expired grant, a disabled account, rejected content — must not burn
 * retries against a wall.
 */
export function shouldRetry(
  state: ExecutionState,
  error: { code: string; retryable: boolean },
): boolean {
  if (state !== "failed") return false;
  return error.retryable;
}
