# The Goal Engine

What Phase 4 (v0.6.0) added, and — more usefully — what it deliberately did not.

The problem this phase solved: the Runtime was complete and dark. A goal row could
be inserted by hand, and `executeGoalRun` would wait forever for a
`GOAL_SCHEDULED` event that nothing sent. There was no way to create a goal, no
way to stop one, and no scheduler behind either.

---

## What landed

| Piece | File |
|---|---|
| Cron parsing, next-firing computation, DST | `src/lib/goals/cron.ts` |
| The validation gate | `src/lib/goals/validation.ts` |
| Deterministic prefill from a sentence | `src/lib/goals/parse.ts` |
| CRUD, pause/resume, the due query | `src/lib/goals/service.ts` |
| Catch-up policy and dispatch | `src/lib/goals/scheduler.ts` |
| The five-minute tick | `src/lib/runtime/inngest/functions.ts` |
| `next_firing_at` + partial index + backfill | `drizzle/0012_goal_next_firing.sql` |

Scheduling itself is documented separately in [`scheduling.md`](./scheduling.md).

---

## One defect fixed, and why it mattered

**A run with no steps reported `completed`.**

Nothing in the codebase has ever written a `run_steps` row — that is Phase 5's
planner's job. So a goal would fire, load zero steps, execute nothing, and settle
as a successful run. The user sees a green run and no post.

A no-op that reports success is the worst outcome available to this system, so
`executeGoalRun` now refuses:

```
run.no_steps → transitionRun(fail) → outcome: "no_plan"
```

The gap is now loud, in the run's own history, instead of silent. The event's
detail says it is expected until AI planning ships, so the failure reads as a
known limitation rather than a bug.

---

## The validation gate

A goal is configured **once and then forgotten**. That single fact drives the whole
design: if an account is disconnected or switched off at save time and nothing
says so, the goal sits there looking healthy and produces nothing, forever, and
the user has no reason to look again.

So every refusal happens at configuration time. `validateGoal` is pure — it takes
the resolved accounts as an argument rather than importing the accounts store — so
the whole gate is testable without Postgres.

It collects **every** issue rather than failing on the first, because a form that
reveals one error per save is a form people give up on.

| Code | Meaning |
|---|---|
| `empty_title` · `title_too_long` | Name missing or over 120 characters. |
| `empty_statement` · `statement_too_long` | Description missing or over 4000. |
| `invalid_schedule` | Does not parse. Names the offending field. |
| `invalid_timezone` | Not an IANA zone this system knows. |
| `unsatisfiable_schedule` | Parses, but can never fire — `0 0 30 2 *` is February 30th. |
| `schedule_too_frequent` | Closer together than the 15-minute floor. |
| `no_targets` · `malformed_target` · `duplicate_target` | The target list is not a list of accounts. |
| `unknown_account` | No connected account matches. |
| `account_disabled` | The account exists and the user switched it off. |
| `capability_unavailable` | Connected, but the platform has no publisher. |

The last three are deliberately **distinct**, because they send the user to three
different places: connect the account, switch it on, or choose a different
platform. Collapsing them into one "invalid account" would make the first two
indistinguishable.

### The roadmap's own example is refused

Phase 4's example is *"Publish two posts about AI every day on LinkedIn and X."*
LinkedIn completes OAuth and has no publisher in this build, so the gate returns
`capability_unavailable` and names it. There is a test for exactly this sentence
in `validation.test.ts`.

Without the gate, that goal would be created, would show a schedule and two target
accounts, and would never publish — the exact failure the whole exercise exists to
prevent.

### The gate is duplicated on purpose

`validateGoal` (goal configuration) and `plan.ts` (plan validation) check the same
properties, and **neither replaces the other**. A goal validated today can have its
account disconnected tomorrow, and a planner's output is untrusted by
construction. The plan gate is what stops an untrusted AI output from naming a
destination it should not.

---

## Editing re-validates everything

`updateGoal` re-runs the whole gate, not just the changed field.

An edit is the natural moment to discover the account is gone — but only if
someone asks. A partial check would also let an edit carry a new schedule past
the gate on the strength of a field that was never re-checked.

A goal that fails the gate is **left exactly as it was**. There is no partial
update and no "save anyway".

Two consequences worth naming:

- A **paused goal stays paused through an edit**, and keeps a `NULL` firing time.
  An edit must not be a way to sneak a paused goal back into the schedule.
- **Resuming recomputes the next firing from now**, not from the old one. A goal
  paused for a month and resumed is not instantly due, and does not fire a month
  of posts at once. "From now" is what the user means by resuming.

---

## Prefill: reading a sentence without pretending to understand it

`prefillGoal()` takes the statement the user is about to write anyway, and finds
the parts a rule can actually read: the platforms named, the cadence implied, the
time of day, a suggested title.

It is a **prefill**, not an interpreter, and the distinction is correctness rather
than politeness. Understanding *"keep my accounts fed with a varied mix of AI
commentary, nothing too salesy"* is a judgement about tone. No regular expression
makes it, and one that claimed to would be worse than useless, because the user
would believe it. That reading is Phase 5's planner's job, and it reads the
statement **verbatim**.

Three rules the module follows:

**It never produces an account key.** A sentence says which *platform*; only the
user knows which of their three X accounts. Guessing here would publish to the
wrong one, silently. The UI resolves platform ids to the user's accounts.

**It returns what is unambiguous and names what is not.** `recognised` lists what
was read; `unresolved` says what was deliberately not guessed, including the
useful case — *"linkedin is connected but cannot publish yet"*, said at typing
time rather than at the first firing.

**It never proposes a schedule its own validator would reject.** A test runs every
prefilled schedule back through `parseCron`, because a form that offers a value
which fails on save is worse than one that offers nothing.

Some things it correctly refuses to do:

| Input | Why it declines |
|---|---|
| "Publish **2** posts every day" | Reads the cadence, not the time. Reading "2" as 02:00 would offer a schedule nobody asked for, so the number must be anchored to "at", a meridiem, or a colon. |
| "Every day" | A cadence with no time. Defaulting to 09:00 would be plausible and wrong, and the user would not know which field they had not looked at. |
| "Post on X at 9am" | A time with no cadence. |
| "Every 90 minutes" | Not expressible in five-field cron. Silently meaning something else would be worse than offering nothing. |
| "Every week" | Picks Monday — and **says so** in `recognised` and in the description. A choice the user cannot see is a choice they did not make. |

---

## What is not here, and why

**No Goals UI.** Phase 7 (v0.9.0) owns the Goals dashboard and the creation form.
This phase ships the engine and the service those screens will call.

**No natural-language planning.** Phase 5 (v0.7.0). The statement is stored and
served verbatim; nothing here interprets it beyond the prefill above.

**No `run_steps`.** Still Phase 5. Until the planner exists, a fired goal produces
a `no_plan` failure rather than a silent success.

**No retry policy for a failed dispatch.** The slot advances and the failure is
reported in the tick's summary. A firing is lost rather than queued for retry,
because a retry here would need somewhere to store "what this firing still owes",
and that is the delivery guarantee Phase 8 hardening is for.

**No per-goal catch-up queue.** Missed firings collapse to one run, deliberately.
See [`scheduling.md`](./scheduling.md#missed-firings-collapse).

---

## Where to look next

- [`goals.md`](./goals.md) — the record and its columns
- [`scheduling.md`](./scheduling.md) — cron, DST, the scheduler
- [`runtime.md`](./runtime.md) — execution state, and the queue boundary
- [`capabilities.md`](./capabilities.md) — why a platform cannot publish
