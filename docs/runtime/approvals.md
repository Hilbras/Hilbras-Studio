# Approvals

A person deciding whether a side effect may happen.
Implemented in [`src/lib/runtime/approvals.ts`](../../src/lib/runtime/approvals.ts)
and [`src/lib/runtime/approval-store.ts`](../../src/lib/runtime/approval-store.ts).

---

## What this phase is

A goal fires, the planner writes a plan, the Runtime walks the steps — and then
it stops, mid-plan, and asks someone. The run lives in the database for as long as
it takes. When the answer arrives, the queue wakes it and it carries on from the
step that was waiting.

```
compose ──▶ publish ──▶ ⏸ awaiting_approval ──▶ publish ──▶ finish
                              │
                    ┌─────────┼──────────┐
                  approve    reject    24h passes
                    │           │          │
                    ▼           ▼          ▼
                 publish     failed     failed
```

The one-line version of the design: **a suspension is a return, not a throw.**
The function that hit the gate completes normally, having done everything it can.
It does not ask the queue for another attempt, because another attempt would
arrive at the same question and asking twice is not a way of asking better.

---

## Only a side effect is worth a question

`ToolSpec.sideEffect` is the whole of it. A tool that changes something outside
this system is one a person may want to see first; a tool that only computes is
not.

```ts
sideEffect: false   // compose_post — writes text that exists only inside the run
sideEffect: true    // publish_post — the post is live on a platform
```

It is a declared field, not derived from `capability !== null`. The derivation
would be wrong the moment a read-only connector tool existed: it delegates to a
platform, and it has no side effect, and a policy built from the wrong one of
those two facts would put a question in front of a step that cannot publish
anything.

`compose_post` therefore has no approval, and a policy naming it is **refused at
write time** rather than accepted and ignored. "Require approval before
composing" cannot be honoured — the text it writes does not exist yet, so the
most the Runtime could do is approve a brief. Accepting the setting would leave
the user believing their account was gated when it is not.

---

## The approval holds the resolved text

A `publish_post` step normally takes its text from a `compose_post` earlier in the
plan, as `{"$ref": {"step": 0, "field": "text"}}`. That is not something a person
can approve: a screen showing a reference is a screen showing a JSON object, and
the one moment a human is actually reading the content is the moment the content
is not there.

So the snapshot an approval carries is the input **after** reference resolution.
Two things follow, and both are the point:

1. What the person reads is exactly what will be published.
2. An edit is an edit of the real text, not of a pointer to it.

The cost is that the snapshot is not re-derivable from the plan alone. It is
persisted, which is why `run_step_approvals` has an `input` column of its own.

This is also why the gate is called *after* `resolveReferences` and *before* the
target account is looked up — see [`permissions.md`](./permissions.md).

---

## What was approved is what publishes

On approval, the executor is handed the input from the **approval row**, not the
step's own `input` column:

```ts
// src/lib/runtime/inngest/functions.ts — resumeDecision
input: JSON.stringify(approval.input),   // not stepRow.input
```

The step's column is the plan's record and usually still holds a `$ref`, which
would resolve to whatever the compose step says — which may not be what the person
was shown. Anything else makes the approval a formality.

`run_step_approvals` has a UNIQUE constraint on `step_id`. A step is executed
once, so it can be asked once: two pending approvals for one step would mean two
people could approve two different versions of the same post, and whichever the
Runtime saw first would be the one published.

---

## Editing before approving

`applyEdit` merges the edit into the snapshot and hands the result to
`validateToolInput` — **the identical function the plan gate uses**, exported from
[`../runtime/plan.ts`](../../src/lib/runtime/plan.ts) rather than reimplemented.

An approval screen is a *later* stage than the gate. A weaker check there would
make the one place a person is looking at the content the one place it is
unchecked, and a human who can write input no planner could write has found a way
around the gate that stops untrusted output from naming a destination.

Three rules, in this order, because each is a way the screen could become a way
around the gate:

| Rule | Why |
| --- | --- |
| Only fields the tool marks `editable` | The person may change what the post says. They may not change which account it goes to, and they may not add a media URL — that is a new capability being granted, not an edit. |
| No `$ref` in an edited value | A `$ref` is valid *plan* input and the shared validator rightly accepts one. But an edit is a literal, and an object shaped like a reference is either a client bug or an attempt to point the publish at some other step's output. |
| The merged input passes the plan's validator | The load-bearing rule. |

`publish_post.text` is the one editable field. `mediaUrl` is not.

### The platform's own limit

`text`'s declared `maxChars` is 20,000 — a sanity ceiling, not X's limit. So the
store also passes the target platform's real limit:

```ts
const limit = PLATFORM_REGISTRY[account.platform].content.maxTextLength;
return limit === null ? {} : { text: limit };
```

Without it an approver could approve 2,400 characters for X and only find out when
the platform refused — after they had said yes.

### A rejected key short-circuits the merge

If any key is rejected, `applyEdit` reports those and does **not** then validate
the merge. The merge is no longer the document the person wrote, so validating it
would describe an input they never chose ("text must be non-empty" for a `text`
they did not send). They fix the keys, and the next submit is the one that gets
fully checked.

---

## The window, and what closing it means

```ts
export const APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1_000;
```

A day, chosen against the thing it has to serve: a goal that fires daily and needs
approval should be answerable before the next firing, so a user who approves once
a day is not permanently one firing behind.

It is a fixed constant rather than a per-policy setting because **the deadline is
stamped onto the row when the approval is created**. Changing the number later
therefore cannot reinterpret a decision a user was in the middle of making.

`expires_at` is `timestamptz` and is compared against `now()` in a query — the
same reasoning as `goals.next_firing_at` in migration 0012. A naive timestamp
would make the deadline depend on the database session's TimeZone.

### A timeout fails, it never approves

A timeout is an absence of consent. The user set this policy *because* they wanted
to see the post before it went out, and publishing it because they were asleep is
the exact opposite of what they asked for. So the deadline settles the step as
failed and the run moves on.

### The reader closes it too, not just the sweeper

`decideApproval` refuses a late answer **and marks the approval expired itself**.
A deadline enforced only by the reader is a deadline a user can always answer the
day after, and enforcing it only in the sweeper would mean an answer arriving in
between depends on the order two independent statements happened to run in. Both
use the same boundary — `isOverdue`, i.e. `now >= expiresAt` — so a decision
cannot be refused by one and published by the other.

### At the instant of the deadline it is closed

`>=`, not `>`. So a caller can state "answerable until T" without also having to
say "or just after".

---

## A decision writes one fact and nothing else

`decideApproval` records the answer. It does not touch the step, the run, or the
queue.

All of that happens in the resume path, which means there is exactly one place
that moves a run out of `awaiting_approval` and exactly one place that executes an
approved step — rather than a decision path and a timeout path that each grew
their own version of both.

The order of the checks is the order of the ways it can go wrong:

1. **Who is asking.** Checked against the approval's own `userId`, not the run's,
   so it is one read of one table. This is the authorization, and it is not
   optional — the ids are the only thing between one user's approval and another
   user's post.
2. **Whether it was already answered.** Two answers means two people who both
   believed they were first. The `UPDATE` carries `state = 'pending'` as a
   *condition*, not just the value read above, so only one of two simultaneous
   answers may write.
3. **Whether the window closed.** See above.
4. **The edit.** Last, and only on an approval, because an edit on a rejection is
   a contradiction rather than a request.

---

## Why a decision resumes the run

All three of `approve`, `reject` and `approval_timeout` lead back to `running`.
They are three distinct *events* because three different things happened and the
run's history has to say which. The destination is the same because the run's
fate was never in question — one step was waiting, and now it is not.

v0.3.0 shipped `reject → cancelled` and `approval_timeout → failed`. **Both
changed in v0.8.0**, and for one reason: they made a human decision about *one
step* decide the fate of *every other step*. A goal pointed at X and Instagram
whose X post is rejected should still post to Instagram, which is the
settle-independently rule v0.5.0 already applies to every other kind of step
failure. Treating a human "no" as a cancellation would make the one failure a user
caused behave differently from every other failure, and the user would have to
learn that rule separately.

---

## Suspension is durable, and here is how

Two things must happen without a person present, so both are on the same
five-minute tick as the goal dispatch:

```
settle-approvals
  │
  ├─ 1. expire anything nobody answered
  │     writes state = 'expired'           (one index scan, partial on state)
  │
  └─ 2. resend decisions that never arrived
        decided approval, whose step is still `awaiting_approval`,
        on a run that is still `awaiting_approval`
```

### Why the resume is a separate function

`execute-goal-run` claims a schedule slot, and `createRun` is idempotent on that
slot — so a resume arriving as another `GOAL_SCHEDULED` would be absorbed and the
run would sit in `awaiting_approval` forever. Rather than weaken the claim, the
resume gets its own function and its own trigger, and both call the shared
`advanceRun`. The claim is what makes at-least-once safe (ADR-005); carving an
exception into it for resumption would give that up for a convenience.

The event carries ids only. The function reads the decision from Postgres, so a
queue message that could be inspected cannot say what a post said or how it was
answered. One event for all three outcomes is deliberate: the decision is a fact
already stored, and the function has to read it before it can act, so naming the
outcome in the event would add a second thing that can disagree with the database.

### Why the lost-message case needs no outbox

The queue is not transactional with Postgres, so a crash between "the person said
yes" and "tell the queue" would otherwise strand the run forever next to an
approved post.

The second sweep query is the safety net, and it costs one query because a
decision is "picked up" exactly when the step it was about stops being
`awaiting_approval`. Once the resume runs, the step is `completed` or `failed` and
the row leaves the set — so a suspended run is re-sent at most once per tick and
only while it is genuinely stuck, not on every tick forever.

### The step claim is a compare-and-swap

```ts
UPDATE run_steps SET state = 'running'
 WHERE id = $1 AND state = $2          -- the expected state
```

Two invocations can reach the same step — the scheduler's and the resume's, or a
queue retry of either — and both would dispatch a publish. Reading the state and
then updating it is not the same thing: the gap between the two is wide enough for
both to see `awaiting_approval` and both to act.

The step's idempotency key would not save it. That key is what a *connector* uses
to absorb a duplicate, and it only works for connectors that implement the cache,
which not all of them do.

A claim is also a *reservation*, so a step that cannot be executed even to
completion hands the claim back — to the state it was in, not to `failed`. A step
left `failed` would be skipped as terminal on the retry and the run would report
success having published nothing.

---

## What is deliberately not here

- **No UI.** The roadmap puts the approval interface in Phase 7. v0.8.0 ships the
  system: policies, questions, decisions, expiry, resumption.
- **No per-policy timeout.** A fixed window, stamped at creation, so a config
  change cannot move a deadline somebody is counting down.
- **A suspended run does not block the next firing.** The goal's
  `next_firing_at` already advanced when the scheduler dispatched it, so a user
  who is slow to approve accumulates a backlog rather than silently losing
  firings. The alternative — a pending approval blocking the schedule — means one
  missed approval deletes a week of posts, which is worse.
- **No approval for a `compose_post`.** See above.

---

## Where to look

| Question | File |
| --- | --- |
| What an approval is, the window, the edit rules | [`approvals.ts`](../../src/lib/runtime/approvals.ts) |
| Reading and writing questions, and the gate | [`approval-store.ts`](../../src/lib/runtime/approval-store.ts) |
| Suspending, resuming, sweeping | [`inngest/functions.ts`](../../src/lib/runtime/inngest/functions.ts) |
| Why a decision resumes the run | [`state.ts`](../../src/lib/runtime/state.ts) |
| Why a human cannot write input a planner could not | [`plan.ts`](../../src/lib/runtime/plan.ts) |
| Where the gate sits in the order | [`permissions.md`](./permissions.md) |
| What a user may configure | [`policies.md`](./policies.md) |
