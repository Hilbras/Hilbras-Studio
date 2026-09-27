# Runtime

How the Hilbras Runtime executes a Goal. Introduced in **Phase 1** (v0.3.0);
expanded by Phases 4–6.

Layer contract: [`architecture.md`](./architecture.md#runtime-phase-1).
Execution detail: [`execution.md`](./execution.md).
Goal model: [`goals.md`](./goals.md).

---

## The shape

```
Goal  (user-owned, long-lived)
  └─ fires on a schedule slot
       └─ Run  (one execution, immutable history)
            └─ Step  (one capability against one account)
                 └─ Connector → platform
```

A Goal is the stable thing the user owns. A Run is one firing of it. A Step is
one thing the plan does. Retries create a **new Run**, never revive a failed
one, so history is append-only and `attempt` is monotonic.

---

## Why a managed queue (ADR-001)

Execution runs on [Inngest](https://inngest.com), not on a Vercel cron and not
on a worker we host.

The deciding factor was **Phase 6**. A Human-in-the-Loop approval can wait
hours or days for a human decision. On Inngest that is a first-class primitive
(`step.waitFor`, `step.sleep`) — the function suspends and resumes on an
external signal, holding no worker. Hand-rolled on top of a plain queue, it
would be a state machine with leases, heartbeats, and expiry — code that exists
only to wait.

The alternatives, for the record:

- **Vercel Cron** — once per day on the Hobby plan, and a 120 s function
  timeout. It cannot hold a multi-step plan open or schedule "every day at
  10 AM".
- **A self-hosted worker** — extends the existing claim/lease pattern and gives
  full control, at the cost of new infrastructure to operate and monitor.

The cost accepted is a vendor dependency and an outbound connection to Inngest's
API. **Only identifiers cross that boundary** — a goal id, a user id, and a
schedule slot. No content, no credentials, no tokens. Everything else is read
from Postgres inside the function.

---

## Configuration

Two variables, from the Inngest dashboard:

| Variable | Purpose |
|---|---|
| `INNGEST_EVENT_KEY` | Lets the app **send** events to Inngest. |
| `INNGEST_SIGNING_KEY` | Lets `/api/inngest` **verify** callbacks really came from Inngest. |

Without the signing key the route accepts requests from anyone, so it must be
set in every deployed environment. Without either pair the application still
runs — only goal execution is unavailable.

`/api/inngest` is Inngest's entry point for event delivery, step results, and
resumption. It is authenticated by the SDK's signature check, so it has no
session or same-origin guard; adding one would break Inngest's callbacks.

---

## Modules

| Module | Responsibility |
|---|---|
| `src/lib/runtime/state.ts` | The execution state machine. Pure. |
| `src/lib/runtime/plan.ts` | The gate a plan must pass before it may act. Pure. |
| `src/lib/runtime/executor.ts` | Runs one step. Connector resolution and the retry decision. |
| `src/lib/runtime/service.ts` | The only writer of run state. Server-only. |
| `src/lib/runtime/inngest/` | The durable function and its event schema. |

The split is deliberate: everything with a decision in it is pure and unit
tested, and only the thin persistence layer needs a database. The most
consequential code in the product — the part that can publish to a real account
— is testable without Postgres, a queue, or a network.

---

## What is server-authoritative (ADR-003)

A transition is a pure function of the current state and an **event**. Nothing
else may write execution state:

- no client may assert a step completed
- no tool argument may name a destination state
- no model output may mark a run successful

A tool returns a typed result; the Runtime decides what that means for state.
The same rule that already governs publish results in v0.1.0, extended to every
layer of execution.

---

## Idempotency (ADR-005)

The queue is **at-least-once**, so a run can be delivered twice for one
schedule slot. Two independent guards, because either alone is insufficient:

1. **`runs.idempotency_key` is UNIQUE.** `createRun` inserts and absorbs the
   constraint violation on redelivery. This is a database guarantee, not a
   check-then-act — a read followed by an insert has a window between them, and
   two concurrent deliveries both pass the read.
2. **Each step carries an idempotency key** derived from
   `(runId, stepIndex, targetAccount)` and forwarded to the connector, which is
   the only component that can tell a platform "I already did this".

The key includes the schedule slot, so a goal firing twice on purpose at two
different times is two runs, while the same slot delivered twice is one.

---

## Failure handling

A connector failure is a typed `ConnectorError`, never a string the Runtime
inspects. The `retryable` flag is the only thing consulted:

| Code | Retryable | Why |
|---|---|---|
| `rate_limited`, `platform_error` | ✅ | The same request can succeed later. |
| `not_connected`, `expired` | ❌ | Only a user action fixes it. |
| `target_unavailable` | ❌ | The grant is fine; the account behind it is gone. |
| `forbidden`, `invalid_content` | ❌ | Retrying the identical request fails identically. |
| `unsupported` | ❌ | No publisher exists. |
| `unknown` | ❌ | **Fail closed.** See below. |

`unknown` is deliberately never retryable. An unclassified failure on a
side-effecting step means the dispatch may already have reached the platform;
retrying it could double-post. The run fails and the uncertainty is recorded in
`run_events` for a human to verify — the same reasoning as
`dispatch_started_at` in the v0.1.0 scheduler.

A failing step does **not** abort its siblings. A goal targeting two accounts
publishes to the one that still works and reports the one that did not, matching
the "settle each target independently" rule the v0.1.0 composer already follows.

---

## Observability

`run_events` is append-only. Every transition, refusal, retry decision, and step
outcome lands there, so a run is explainable without reconstructing it from the
mutable tables. Two event names are worth knowing:

- `run.redelivery_ignored` — a duplicate delivery was absorbed
- `run.transition_refused` — an event did not apply, meaning the caller's view
  was stale

Refusals are recorded rather than thrown, so a redelivered step cannot crash a
run that already finished on its own.

---

## The step order

```
start run
  │
  ├─ plan-run ────────────  writes run_steps, or fails the run
  │
  ├─ load steps
  │
  ├─ for each step, in order
  │     ├─ resolve $refs against settled results
  │     ├─ dispatch: a connector tool, or a Runtime tool
  │     └─ record the outcome
  │
  └─ finish run
```

Planning is the first thing that happens to a run, and it is the only step that
can end one before a single dispatch. See
[`runtime/planning.md`](./runtime/planning.md).

---

## Not yet implemented

- **approvals**, which is what the queue was chosen for (Phase 6)

The **planner** and the **scheduler** shipped in Phase 5 (v0.7.0) and Phase 4
(v0.6.0) respectively — see [`runtime/planning.md`](./runtime/planning.md) and
[`scheduling.md`](./scheduling.md).

`run.no_steps` remains in `executeGoalRun` as a backstop. It was the honest
failure for a goal that fired with nothing to do; now that the planner writes the
steps, reaching it means the planner was bypassed, and that is still worth a loud
failure rather than a green one.

