# Execution

The state machine and the step loop. Introduced in **Phase 1** (v0.3.0).
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
   │                              reject ────────┼──▶ cancelled
   │                              timeout ───────┴──▶ failed
   │
   └──cancel────────────────────────────────▶ cancelled
```

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

It is reached from `running` and returns to `running` on approve — which is also
how an auto-approve timeout policy resolves, since the function resumes either
way.

### Rejection is a cancellation, not a failure

`reject` goes to `cancelled`, not `failed`. Nothing went wrong; the user said no.
A run that fails for that reason would report an error the user caused and did
not intend.

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
3. load-steps    read persisted steps in plan order
4. per step      executeStep → settleStep, skipping already-terminal steps
5. finish-run    all completed → succeed; any failure → fail
6. maybe retry   a new event with attempt + 1, if warranted and under the cap
```

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
