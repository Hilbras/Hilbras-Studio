# Planning a run

The step between "a goal fired" and "the Runtime has something to do".
Implemented in [`src/lib/runtime/planning.ts`](../../src/lib/runtime/planning.ts).

---

## What Phase 4 could not ship

Nothing had ever written a `run_steps` row. A goal would fire, execute nothing,
and report success — a run that did no work and said it had. v0.6.0 turned that
into an honest failure (`run.no_steps`, outcome `no_plan`) and left it as a
backstop. The planner is what makes a fired goal produce posts, and the backstop
is now unreachable in normal operation rather than deleted.

This is also the first place in the system where a model's output is about to
cause something to happen in the world.

---

## The order of the four checks

```
  ┌─ 1. Can this goal be planned at all? ────────────────┐
  │    every target connected, enabled, deliverable      │
  │    ✗ → plan.no_usable_target, 0 model calls         │
  └──────────────────────┬───────────────────────────────┘
                         ▼
  ┌─ 2. The model proposes ──────────────────────────────┐
  │    injected Completer, no provider in this function  │
  └──────────────────────┬───────────────────────────────┘
                         ▼
  ┌─ 3. The gate decides ────────────────────────────────┐
  │    validatePlan, against the goal's targets         │
  │    ✗ → one repair with the issues verbatim          │
  └──────────────────────┬───────────────────────────────┘
                         ▼
  ┌─ 4. One transaction ─────────────────────────────────┐
  │    runs.plan + every run_steps row, or neither       │
  └──────────────────────────────────────────────────────┘
```

**Preflight runs before the model.** A planner cannot fix a disconnected
account. Calling it to be told the same thing back spends a call, produces
nothing, and hides the real reason behind a validation error the user has no way
to act on.

The preflight messages are per account, because they send the user to three
different places:

```
This goal cannot be planned: "x:hilbras" is switched off. Reconnect or switch
the account on, or change the goal's targets.
```

"an account is not usable" would send them to none of them.

---

## The gate is checked against the goal's accounts, and only those

```ts
validatePlan({
  plan: proposed.plan,
  accounts: runtimeAccounts,        // built from goal.targetAccounts
  capabilitiesFor,
  requiredTargets: goal.targetAccounts,
});
```

Two separate jobs, both load-bearing:

- **`accounts`** is the *allowed* set. A step naming anything else is refused
  with `unknown_account`. This is where "prevent unauthorized tool usage" is
  enforced — not in the prompt.
- **`requiredTargets`** is the *required* set. A plan that never delivers to one
  of the goal's accounts is refused with `uncovered_goal_target`.

A goal pointed at X and Instagram that posts only to X looks like it worked, and
this is how the user finds out their second account went quiet. Note the check
keys off `deliversToAccount`, not "the account was mentioned" — a plan that
drafted for both and published to neither is still a refusal.

**Narrowing the gate's own account lookup** is what makes `unknown_account`
trustworthy. If the gate resolved accounts from the user, a valid plan could
name an account the goal does not target. `validatePlan` restricts its lookup to
`requiredTargets` when one is given, so a convention nobody is forced to follow
is not a gate.

### A goal validated today can have its account disconnected tomorrow

`validateGoal` already refuses a goal pointing at a disabled or connect-only
account, at save time. The preflight is not redundant: it is the same check
again, at firing time, for the case the save-time check cannot cover. There are
integration tests for both, against the same fixtures, so neither can be deleted
on the argument that the other one has it covered.

---

## The repair loop

One attempt, the gate's issues verbatim, one more attempt. Both in this function,
both before any step has run. The reasoning is in
[`../ai/planner.md`](../ai/planner.md#the-repair-loop-and-where-it-stops).

What `planRun` adds is the *outcome* mapping, and the insistence that nothing here
is retried by the queue except a model call that failed in transit:

| `code` | `retryable` | Why |
|---|---|---|
| `run_not_found` | no | |
| `goal_not_found` | no | The goal was deleted. |
| `no_usable_target` | no | Reconnect is the fix, not a retry. |
| `ai_unavailable` | **yes, if the model failed in transit** | A 503 clears. |
| `unreadable_reply` | no | The repair already happened. |
| `plan_rejected` | no | The next firing generates a fresh plan. |

A rejected plan is not retried within the slot: a second attempt would spend two
more model calls to arrive at the same refusal, and the same refusal is what the
next firing will produce anyway from a fresh context.

---

## What is written, and the refusal to write twice

`persistPlan` writes `runs.plan` and every `run_steps` row in **one transaction**,
and refuses if the run already has steps.

```
Run 4f2a… already has a plan of 4 steps. Not replacing it.
```

This is the queue's at-least-once delivery meeting an irreversible action. The
queue is allowed to redeliver the planning step; it is not allowed to change what
the run is about to publish. `created: false` is not an error — it is the
redelivery, and the caller carries on with the plan that is already there.

Each step's idempotency key includes its index:

```
run:{runId}:{stepIndex}:{targetAccount ?? "no-account"}
```

so a plan publishing twice to one account is two dispatches rather than one
silently deduplicated. A step is a *position in a plan*, not a destination.

---

## Who decides what the run becomes

`planRun` does not move the run's state. It records events and returns a
`PlanRunResult`; the queue function in
[`inngest/functions.ts`](../../src/lib/runtime/inngest/functions.ts) owns the run
lifecycle and is the one place that moves a run from `pending` to `running` to a
terminal state.

`planRun` never throws for an expected failure. A missing provider, an unreadable
reply, a refused plan — each becomes an event on the run and a returned result.
A planning failure that crashed the function would be retried by the queue with
nothing recorded about what the model said, which is the one thing worth having
when a goal stops working on a Tuesday.

---

## Events it records

| Event | Level | When |
|---|---|---|
| `plan.no_usable_target` | error | Preflight refused. Zero model calls. |
| `plan.rejected` | warn | The gate refused an attempt. Carries every issue. |
| `plan.created` | info | First attempt accepted. |
| `plan.repaired` | warn | A repaired attempt accepted. Carries what was fixed. |
| `plan.ai_unavailable` | error | The model did not answer. |
| `plan.unreadable_reply` | error | Two unparseable replies. |
| `plan.plan_rejected` | error | Two refused plans, no steps written. |

---

## Spend

Every model call in a run goes through one `createCompleter`, which charges in
this order:

1. the run's own meter (`perPlan` / `perStep`, then `perRun`),
2. the deployment and per-user window budget,
3. the provider.

The order is the point. A call refused by the run's meter must not touch the
window budget, or a planner hitting its own ceiling would throttle the user's
Assistant for no reason they could act on.

Defaults are `perPlan: 2, perStep: 2, perRun: 12` — see
[`../ai/limits.ts`](../../src/lib/ai/limits.ts) and
[`../runtime/execution.md`](../execution.md) for what the ceiling does and does
not bound.

---

## In the run

```
executeGoalRun
  ├─ start run
  ├─ plan-run            ← this
  ├─ load steps
  ├─ for each step
  │    ├─ resolve $refs from settled results
  │    ├─ dispatch: connector tool, or a Runtime tool
  │    └─ record outcome
  └─ finish run
```

A planning failure is a run failure, with `outcome: "no_plan"` or the specific
code. It is not a step failure — nothing ran.

---

See also [`../ai/planner.md`](../ai/planner.md),
[`../ai/context.md`](../ai/context.md), [`../ai/tools.md`](../ai/tools.md), and
[`../runtime.md`](../runtime.md).
