# Execution

The state machine and the step loop. Introduced in **Phase 1** (v0.3.0);
suspension and the permission gate added in **Phase 6** (v0.8.0).
Overview: [`runtime.md`](./runtime.md).

Source: `src/lib/runtime/state.ts`, `executor.ts`, `inngest/functions.ts`.

---

## Execution states

```
pending ──start──▶ running ──succeed────▶ completed
   │                  │
   │                  ├──fail─────────▶ failed
   │                  │
   │                  └──request_approval──▶ awaiting_approval
   │                                            │
   │                              approve ───────┤
   │                              reject ────────┼──▶ running   (v0.8.0)
   │                              timeout ───────┘
   │
   └──cancel────────────────────────────────▶ cancelled
```

The three arrows out of `awaiting_approval` lead to the same place, and the run
then settles from its **step** outcomes, not from the decision. See
[Every decision resumes the run](#every-decision-resumes-the-run).

| State | Terminal | Holds a lease | Meaning |
|---|---|---|---|
| `pending` | no | no | Claimed, not started. |
| `running` | no | **yes** | Executing. |
| `awaiting_approval` | no | **no** | Suspended on a human decision. |
| `completed` | ✅ | no | Every step succeeded. |
| `failed` | ✅ | no | A step failed and will not be retried. |
| `cancelled` | ✅ | no | Stopped deliberately. |

### `awaiting_approval` is a suspension, not a flavour of `running`

Modelled as its own state because it is neither finished nor active. A waiting
run must **not** be reclaimed as a stale lease, and must **not** be reported as
executing. `isSuspended()` exists so the lease logic keys off that explicitly
rather than inferring it.

It is reached from `running` and returns to `running` on **any** of the three
decisions. The function that reached it has already returned — a suspension is a
return, not a throw — so the transition happens in a *different* invocation, one
woken by the decision. See
[`runtime/approvals.md`](./runtime/approvals.md).

### Every decision resumes the run

**v0.8.0 changed two of these.** v0.3.0 shipped `reject → cancelled` and
`approval_timeout → failed`; both now go to `running`.

They changed because they made a human decision about *one step* decide the fate
of *every other step*. A goal pointed at X and Instagram whose X post is rejected
should still post to Instagram, and the settle-independently rule v0.5.0 already
applies to every other kind of step failure says exactly that. Treating a
human's "no" as a cancellation would make the one failure a user caused behave
differently from every other failure, and the user would have to learn that rule
separately.

The **difference is recorded on the step**, not the run: the X step settles
`failed` with `approval_rejected`, so the history says precisely which decision
was taken and what it cost.

`cancel` remains the one decision that ends a run. It is in `FINISHES_RUN`; the
three approval decisions are not, because stamping `finished_at` would mark a run
finished while it was still executing.

### Failed is terminal

A retry does not revive a `failed` run. The queue re-invokes the executor, which
starts a **new attempt** as a new Run with `attempt + 1`. Two consequences:

- `attempt` is monotonic, so "how many times has this been tried" is answerable
  from the history without replaying it.
- A redelivered message for an old run finds it terminal and is absorbed, rather
  than resuming a run that already exhausted its attempts.

---

## The step loop

```
1. claim-run     createRun is idempotent; a redelivery stops here
2. start-run     pending → running
3. plan-run      the AI writes run_steps                     (fresh firings only)
4. load-steps    read persisted steps in plan order
5. per step      claim → resolve → PERMISSION GATE → execute → settle
6. finish-run    all completed → succeed; any failure → fail
7. maybe retry   a new event with attempt + 1, if warranted and under the cap
```

Since v0.8.0 steps 4–6 are the shared `advanceRun`, called from two functions:
`execute-goal-run` after planning, and `resume-goal-run` when an approval is
answered or expires. Only step 3 is skipped on a resume, and it has to be —
`planRun` charges a model call before it discovers the plan already exists.

Two things in step 5 are new:

- **A claim first.** `UPDATE … WHERE state = $expected`. Two invocations can
  reach the same step, and a read-then-update has a window between them.
- **The gate**, between reference resolution and the connector lookup. It can
  return `allow`, `needs_approval`, or `deny`, and only the first dispatches.

A step that suspends returns from the function here — no settlement, no retry.

Each phase runs inside an Inngest `step`, so its outcome is persisted. A crash
mid-run replays from the last completed step rather than from the beginning.

**A failing step does not abort its siblings.** Each step settles independently,
so a goal targeting three accounts publishes to the two that work and reports
the one that does not. This mirrors the v0.1.0 composer, which already settles
each platform independently.

---

## `executeStep` — the rules

The only place a capability is invoked. Collaborators are injected, so it is
testable without a database or a network.

1. **The connector is resolved from the target account, never hardcoded.** A step
   names a *capability*; the platform is a property of the account. This is what
   keeps platform APIs out of the Runtime.
2. **An unknown account fails closed.** A step naming an account that cannot be
   resolved never becomes a silent no-op — a no-op reported as success is the
   worst available outcome.
3. **Retry is a decision, not a side effect.** The executor returns
   `shouldRetry`; it never re-invokes itself. Only the queue retries, because
   only the queue knows its own backoff and budget.

### What it refuses before dispatching

A missing target, a connector that lacks the capability, empty text, and
malformed stored input are all rejected without touching the platform. Only the
checks that require a call happen after the cheap ones.

### The permission gate is a required dependency

```ts
interface ExecutorDeps {
  resolveConnector: …;
  approval: StepPermissionGate;   // required, and there is no default
  runLocalTool: LocalToolRunner;
}
```

The v0.7.0 `defaultDeps` is deleted. An unused object that assembles a working
set of dependencies is an invitation: the next caller to reach for it gets a
runtime that publishes unattended, with nothing at the call site saying so.

The gate is called **after** `$ref` resolution — the person has to be shown the
real text — and **before** the connector lookup, because "you may not do this"
beats "you might not be able to" and a forbidden action should not cost a
database read. Full detail in
[`runtime/permissions.md`](./runtime/permissions.md).

### A connector that throws is `unknown`

A connector that raises has not reported an outcome, so the dispatch status is
**unknown**. That is treated as non-retryable: the platform may already have
received it, and retrying could double-post. The run fails and the uncertainty
is recorded for a human — the same rule as `dispatch_started_at` in the v0.1.0
scheduler.

---

## Retry policy

`MAX_ATTEMPTS` is 3. A retry is requested only when **every** failure in the run
was retryable — a single non-retryable failure means the run is finished,
because retrying would just re-publish the steps that already succeeded.

That is the reason a step does not auto-retry on its own. Each step's
idempotency key protects against a *duplicate*, but re-running a whole plan
because step 2 hit a rate limit would re-publish step 1, whose key the
connector can only honour if it has implemented the result cache. Phase 3 gives
every side-effecting connector that cache; until then, a partial re-run is the
riskier option and the Runtime declines it.

**v0.8.0: a resume is not retried at all.** A resumed run is the same attempt,
continuing — it has no `attempt` number and no schedule slot, and the next
scheduled firing is the next chance. That is also what stops a second attempt
re-publishing a post that went out while the person was deciding.
