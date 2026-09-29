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

The deciding factor was **Phase 6**, and v0.8.0 is where that decision was cashed
in. A Human-in-the-Loop approval can wait hours or days for a human decision, and
a queued invocation that returns normally is a first-class way to express "this
is waiting, not this is failing". Hand-rolled on top of a plain queue, it would be
a state machine with leases, heartbeats, and expiry — code that exists only to
wait.

The alternatives, for the record:

- **Vercel Cron** — once per day on the Hobby plan, and a 120 s function
  timeout. It cannot hold a multi-step plan open or schedule "every day at
  10 AM".
- **A self-hosted worker** — extends the existing claim/lease pattern and gives
  full control, at the cost of new infrastructure to operate and monitor.

The cost accepted is a vendor dependency and an outbound connection to Inngest's
API. **Only identifiers cross that boundary** — a goal id, a user id, a schedule
slot, and since v0.8.0 a run id and an approval id. No content, no credentials,
no tokens, and no record of what a post said or how it was answered. Everything
else is read from Postgres inside the function, which is what makes a queue that
could be inspected a queue that cannot leak an unapproved draft.

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
| `src/lib/runtime/approvals.ts` | Approval states, the window, edit rules, policy targets. Pure. |
| `src/lib/runtime/executor.ts` | Runs one step. Permission, connector resolution, the retry decision. |
| `src/lib/runtime/approval-store.ts` | Policies, questions, decisions, and the permission gate. Server-only. |
| `src/lib/runtime/service.ts` | The only writer of run state. Server-only. |
| `src/lib/runtime/inngest/` | The durable functions and their event schema. |

The split is deliberate: everything with a decision in it is pure and unit
tested, and only the thin persistence layer needs a database. The most
consequential code in the product — the part that can publish to a real account
— is testable without Postgres, a queue, or a network.

v0.8.0 added the permission gate as a **required** dependency of the executor
rather than something the executor reaches for itself. A permissive default would
mean forgotten wiring publishes unattended, with nothing at the call site saying
so. See [`runtime/permissions.md`](./runtime/permissions.md#the-dependency-is-required-with-no-default).

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
| `policy_denied` | ❌ | The user's own configuration forbids it. A retry cannot change a policy. |
| `approval_rejected` | ❌ | A person said no. Asking again is not a retry. |
| `approval_expired` | ❌ | Nobody answered in the window. An absence of consent is not consent. |
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
  │     ├─ claim it          ── a compare-and-swap, see below
  │     ├─ resolve $refs against settled results
  │     ├─ PERMISSION GATE   ── allow / ask / deny
  │     ├─ dispatch: a connector tool, or a Runtime tool
  │     └─ record the outcome
  │
  └─ finish run
```

Planning is the first thing that happens to a run, and it is the only step that
can end one before a single dispatch. See
[`runtime/planning.md`](./runtime/planning.md).

The permission gate sits **after** reference resolution and **before** the
connector lookup: the person being asked has to be shown the real text, and a
forbidden action should not cost a database read. See
[`runtime/permissions.md`](./runtime/permissions.md#where-it-sits-and-why-the-position-is-the-point).

### A third ending: suspended

v0.8.0 gave a run a state it did not have before. A step whose policy requires
consent ends in `awaiting_approval`, the run transitions to `awaiting_approval`,
and the function **returns normally** — it does not throw, and it does not ask the
queue for another attempt, because another attempt would arrive at the same
question.

The run now lives in Postgres rather than in the queue. A decision or an expiry
wakes it through `APPROVAL_DECIDED`, and a separate function picks up from the
step that was waiting. Details in
[`runtime/approvals.md`](./runtime/approvals.md).

### All three decisions resume the run

`approve`, `reject` and `approval_timeout` all lead back to `running`. v0.3.0
shipped `reject → cancelled` and `approval_timeout → failed`; **both changed**,
because they made a human decision about *one step* decide the fate of *every
other step*. A goal pointed at X and Instagram whose X post is rejected should
still post to Instagram, which is the settle-independently rule above applied
consistently. `cancel` remains the one decision that ends a run. The reasoning is
recorded in [`runtime/approvals.md`](./runtime/approvals.md#why-a-decision-resumes-the-run).

---

## Claiming a step, and giving the claim back

```sql
UPDATE run_steps SET state = 'running', started_at = $3
 WHERE id = $1
   AND state = $2                      -- the state it was expected to be in
   -- and, only when $2 = 'running':
   AND started_at < $3 - INTERVAL '5 minutes'
```

v0.8.0 added a second trigger alongside the scheduler's, so two invocations can
now reach the same step — the scheduler's and the resume's — and both would
dispatch a publish. Reading the state and then updating it is not the same thing:
the gap between the two is wide enough for both to see `awaiting_approval` and
both to act. The step's idempotency key does not save it either, because that
only helps connectors which implement the cache, and not all of them do.

### A claim is a lease, not a flag (v0.9.5)

The compare-and-swap above was the whole of the protection until v0.9.5, and it
was not enough. `$2` is the state the caller *read*, which is the live state — so
`claimStep(stepId, "running")` **succeeded**, and a redelivery of the same event
started a second invocation while the first was still inside the step body. Both
executed it, and both published.

So a step observed in `running` is now claimable only once its claim is older than
`STEP_CLAIM_LEASE_MS` (5 minutes), checked in the same `WHERE` clause so the
refusal is atomic with the claim. The queue is at-least-once, so a redelivery is
normal operation rather than an edge case.

Five minutes is generous on purpose. A model call is bounded at 30s and a publish
is bounded by the connector deadline, so a step still `running` after that long is
not slow, it is gone. It is also the approval sweeper's cadence, so a reclaimed
step is noticed on the same tick a lapsed approval is.

`claimStep(stepId, from, now)` takes the clock as a parameter, so the lease
arithmetic is testable without waiting five minutes — the same rule
[`view.ts`](runtime/view.ts) follows for the approval deadline.

A claim is also a *reservation*, so a step that cannot be executed even to
completion hands it back — to the state it was in, not to `failed`. A step left
`failed` would be skipped as terminal on the retry, and the run would report
success having published nothing.

**Both recovery paths are needed.** `releaseStepClaim` covers a crash a `catch`
can reach, and makes the retry immediate. The lease covers a worker killed
outright, which never runs a `catch` — without it, refusing `running` outright
would trade a double-execution bug for a permanently stuck run.

Nothing sweeps a stale claim proactively; a step recovers when the queue
redelivers the run on its next retry. See ADR-009.

---

## Not yet implemented

Named here so their absence reads as a decision rather than an oversight.

- **Graceful shutdown.** There is no `process.on` handler anywhere. What an
  in-flight publish should do when the process is asked to stop is an open
  question — aborting mid-publish risks a half-sent post that the platform has
  already accepted.
- **Stale-`running` reclamation.** The claim lease (ADR-009) bounds how long a
  stuck step blocks a run, and a step recovers on the next queue redelivery, but
  nothing proactively sweeps a run whose invocation is gone. A sweeper needs a
  definition of "gone" that does not fight a legitimately slow step.
- **Inngest queue configuration.** Only `retries` is set. There is no
  `concurrency`, no `throttle`, and no `maxEvents`, so a platform outage
  translates directly into a retry storm.
- **Per-run and per-step timeouts inside the executor.** The connector deadline
  (ADR-012) bounds each individual HTTP call, and the lease bounds the step, but
  the run itself has no deadline.
- **`execution_policies` do not gate manual or scheduled publishes.** They are
  consulted before the Runtime runs a step, so they govern AI-planned runs only.
  See [`security.md`](security.md) §3 for why that is deliberate.

The **planner** and the **scheduler** shipped in Phase 5 (v0.7.0) and Phase 4
(v0.6.0) respectively; the **approval system and its interface** shipped in
Phase 6 (v0.8.0) and Phase 7 (v0.9.0) — see [`runtime/planning.md`](./runtime/planning.md),
[`scheduling.md`](./scheduling.md), and [`runtime/approvals.md`](./runtime/approvals.md).

`run.no_steps` remains in `executeGoalRun` as a backstop. It was the honest
failure for a goal that fired with nothing to do; now that the planner writes the
steps, reaching it means the planner was bypassed, and that is still worth a loud
failure rather than a green one. v0.9.5 gives it an `errorSummary` so the run
detail screen says *why* rather than showing an empty error panel.

