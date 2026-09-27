# Scheduling

How a goal turns into a run. The rule parser is
[`src/lib/goals/cron.ts`](../src/lib/goals/cron.ts); the module that *uses* it to
decide what is due is [`src/lib/goals/scheduler.ts`](../src/lib/goals/scheduler.ts).

---

## A schedule is a promise about local time

"Every day at 09:00" means 09:00 **in the user's own time zone**, not 09:00 UTC.
This is the single most important thing about the design, and it is the reason a
schedule is stored as a cron expression plus an IANA zone rather than as a
timestamp.

Storing an instant would be simpler to write and wrong twice a year. A goal
scheduled for 09:00 would drift to 08:00 and back, depending on which side of a
daylight-saving transition it fell. The user chose a time of day; the system owes
them that time of day.

`goals.schedule_cron` and `goals.schedule_timezone` are the source of truth. Both
are written through the validation gate and never edited by anything else.

---

## The grammar

Five fields, in this order:

```
minute  hour  day-of-month  month  day-of-week
```

| Field | Range | Names |
|---|---|---|
| minute | 0–59 | |
| hour | 0–23 | |
| day-of-month | 1–31 | |
| month | 1–12 | `JAN`…`DEC` |
| day-of-week | 0–7, where 7 is Sunday | `SUN`…`SAT` |

Each field accepts a single value, a range, a step, or a comma-separated mix:

| Form | Meaning |
|---|---|
| `A` | one value |
| `A-B` | an inclusive range |
| `*` | every value in the field |
| `W/N` | every Nth value, counting from the low bound |
| `A-B/N` | every Nth value within the range |
| `A/N` | every Nth value from A to the end |

Macros are also accepted and expanded: `@hourly`, `@daily`, `@midnight`,
`@weekly`, `@monthly`, `@yearly`, `@annually`.

The parser **rejects rather than repairs**. A goal saved with a schedule the
parser only mostly understood is a goal that fires at a time nobody chose, and the
scheduler is the last place that would notice. `1e1` is not a minute field even
though `Number("1e1")` is 10.

### The day rule

When **both** day fields are restricted, a date matches if *either* does.
`0 0 1 * 1` fires on the 1st **and** on every Monday.

This is Vixie cron behaviour, it is widely reimplemented as AND by mistake, and the
difference is a goal that fires far less often than the user asked for — invisible
until someone reads the expression and cannot reconcile it. The distinction
between `*` and `1-31` is carried explicitly in `CronFields.domRestricted`,
because the two produce the same set of days and opposite behaviour.

---

## Daylight saving

Two facts about real time zones are handled explicitly, and both are tested by
name in `cron.test.ts`.

**A gap — the wall clock skips an hour.** On the morning a zone jumps 02:00 →
03:00, the wall clock never shows 02:30. That firing is **skipped**, exactly as
cron specifies. A daily 02:30 goal simply does not run that morning, and the next
day is unaffected.

**A fold — the wall clock repeats an hour.** Going 03:00 → 02:00, the wall clock
shows 02:30 twice, and both instants are real. The goal fires **once**, at the
earlier one.

That second case is the reason `localToUtc` tries every plausible offset and takes
the earliest valid result rather than trusting one. Firing twice would mean two
posts, and a duplicate publish is the one failure mode the rest of the Runtime
spends a great deal of machinery preventing — it would be absurd to reintroduce it
here.

Resolution uses `Intl.DateTimeFormat` with `hourCycle: "h23"` rather than
`hour12: false`, because some ICU versions render midnight as hour `24` under the
latter, which silently pushes a midnight schedule to the following day.

---

## The interval floor

**Two firings of one goal may be no closer than 15 minutes**
(`MIN_GOAL_INTERVAL_MS`).

A goal publishes on *every* firing, so this is also the floor on how often the
product can post to a single account on a user's behalf. Fifteen minutes is well
inside every platform's rate limit and comfortably below the frequency at which
repeated identical posts look like abuse to the platform and get the grant
revoked — a failure that costs the user their connection, not just this goal.

The rule is enforced by **probing real consecutive slots**, not by reading the
expression. `0,5,10 * * * *` looks like a reasonable schedule and posts twelve
times an hour; `*/5 * * * *` looks obviously wrong and is the same thing. Only the
gap between actual firings is the property that matters.

---

## The scheduler

`dispatchDueGoals()` runs every five minutes as an Inngest cron function
(`dispatch-due-goals`). It is a **poll, not a queue of timers**: one index scan
finds everything due, and Inngest's own per-goal cron support would instead need a
durable job per goal and give up that single query.

The tick lives in Inngest rather than in Vercel Cron because the queue already
owns execution (ADR-001). A second scheduler would need its own secret, its own
timeout budget, and its own idea of what is running — a second source of truth
about work in flight.

### The query

```sql
WHERE status = 'active' AND next_firing_at <= now()
```

which is the `goals_due_idx` partial index:

```sql
CREATE INDEX goals_due_idx ON goals (next_firing_at) WHERE status = 'active';
```

`next_firing_at` exists so this is an index scan. The alternative — evaluating
every active goal's cron on every tick — would mean reimplementing cron **and** DST
arithmetic in SQL, which is the work `cron.ts` already does and has tests for.

The column is `timestamptz`, unlike every other timestamp in this schema, on
purpose. It holds an absolute instant and is compared against `now()`; a bare
`timestamp` is read and written in whatever `TimeZone` the session happens to
have, so the same row would read differently depending on which pooled connection
served the query.

It is **derived state**, never a source of truth. Every mutation that can change
`schedule_cron` or `schedule_timezone` recomputes it in the same statement.

### Advance first, then dispatch

For each due goal: write the next firing time, *then* send the event.

The reverse order looks more natural and is worse. If the process dies between the
two steps, the goal is still due on the next tick and the scheduler sends the same
slot again. That is survivable — the run's unique idempotency key absorbs it as a
redelivery (ADR-005) — but it is wasted work on a loop that never gets past the
slot that killed it.

Advancing first **cannot** double-publish. If the process dies before the
dispatch, one firing is lost: visible, bounded, and strictly better than a
scheduler that wedges.

### Missed firings collapse

`advanceGoal` computes the next slot from **now**, not from the slot just handled.

A goal that posts twice a day and missed a weekend comes back and posts **once**,
not five times. An outage must not become a spam run, and the run that is actually
due is not more important than the ones after it.

The trade-off is explicit: a goal that missed five firings performs one. The
alternative — a catch-up run per missed slot — is how an outage turns into five
times the intended volume.

### The slot is the idempotency key

The schedule slot is derived from the goal's *stored firing time*, not from `now`:

```
slotKey(2026-09-28T07:00:00Z) === "2026-09-28T07:00Z"
```

Two dispatches of the same firing therefore produce the same
`runIdempotencyKey(goalId, slot)`, and `runs.idempotencyKey` being UNIQUE absorbs
the second as a redelivery. That is a database constraint doing the work, not a
read-then-write check with a window between the two.

---

## Failure modes

| Situation | What happens |
|---|---|
| Stored schedule no longer parses | Firing time set to `NULL`; the goal stops being selected and stays in place for the user to fix. It is never archived on their behalf. |
| Schedule can never fire (`0 0 30 2 *`) | Rejected at creation, not at the first tick. |
| The queue rejects the event | Slot already advanced, so the failure cannot loop. One firing lost; reported in the tick's summary. |
| The goal is paused while a message is in flight | `createRun` re-reads status at execution time and throws. The scheduler's view is never trusted. |
| A goal is created before the column existed | Migration 0012 backfills every active goal to `now()`. A schedule that has already passed *is* due, and nothing recorded whether it was ever served. |

That last row is the reason `goal-migration.test.ts` exists as a separate file: a
backfill cannot be observed from a database that migrated to the end before any
row was inserted. That test would pass with the `UPDATE` deleted.

---

## Where to look

| Concern | File |
|---|---|
| Grammar, DST arithmetic, human description | `src/lib/goals/cron.ts` |
| Interval floor, satisfiability, target validation | `src/lib/goals/validation.ts` |
| Reading a sentence for a prefill | `src/lib/goals/parse.ts` |
| CRUD, `next_firing_at`, pause/resume | `src/lib/goals/service.ts` |
| Which goals are due, catch-up policy | `src/lib/goals/scheduler.ts` |
| The five-minute tick | `src/lib/runtime/inngest/functions.ts` |
| Post scheduling (a different thing) | [`execution.md`](./execution.md) |
