# Goals

The Goal model and its engine. The **table** landed in Phase 1 (v0.3.0); the
**goal engine** — parsing, validation, creation, scheduling, pause/resume — landed
in Phase 4 (v0.6.0).

For how a goal becomes a run, see [`scheduling.md`](./scheduling.md). For the
design decisions behind this phase, see [`goal-engine.md`](./goal-engine.md).

---

## The record

`goals` — [`src/db/schema.ts`](../src/db/schema.ts)

| Column | Meaning |
|---|---|
| `id` | Primary key. |
| `user_id` | Owner. Cascades on user delete. |
| `title` | The user's short label, e.g. "Daily AI posts". |
| `statement` | The goal **verbatim**, in the user's own words. |
| `schedule_cron` | Already-validated cron. Parsed once, at the edge. |
| `schedule_timezone` | IANA zone the schedule is expressed in. Defaults to `UTC`. |
| `target_accounts` | JSON array of `platform:handle`. |
| `status` | `active` · `paused` · `archived`. |
| `next_firing_at` | When this goal is next due. Derived; `NULL` when not active. |

`next_firing_at` arrived in v0.6.0 (migration 0012) as `timestamptz`. It is
derived state — `schedule_cron` and `schedule_timezone` are the source of truth,
and it is recomputed whenever either changes. It exists so the scheduler's query
is one index scan rather than a cron evaluation per active goal.

---

## Three decisions worth knowing

**The statement is kept verbatim.** It is never rewritten or normalised. Phase 4
reads the unambiguous parts of it to prefill a form — which platforms are named,
what cadence is implied — and **Phase 5's planner reads it and interprets it**.
Storing the user's actual words means the planner sees what they meant, and the
record of *why* a run did something survives the parser changing underneath it.

**`schedule_cron` holds a validated value, not raw input.** Parsing and validation
happen once, at the edge, in `validateGoal`, before anything is stored. The
scheduler never re-parses user input, so there is exactly one place a malformed
schedule can be rejected — and exactly one to test.

**`target_accounts` is a list, not a comma-separated string.** This is the
opposite of `posts.platforms`, which was a string and is why Phase 3 had to
migrate it. Storing a JSON array of `platform:handle` meant only the column had
to be replaced, with no re-parsing and no data loss.

The list is still not a foreign key. The gate validates each entry against the
owner's own connected accounts at save time, and `createRun` and the plan gate
re-check at execution time — an unknown account fails the run, it is never
silently dropped.

---

## Status

| Status | New runs | Firing time | Existing runs |
|---|---|---|---|
| `active` | created on each firing | set | continue |
| `paused` | **refused** — `createRun` throws | `NULL` | continue to completion |
| `archived` | refused | `NULL` | continue to completion |

Pausing clears `next_firing_at` rather than leaving it stale. A paused goal that
still looks due is a paused goal that publishes, and that is the one thing
"pause" has to mean.

A paused goal stops *producing* work; it does not abandon a run already in flight.
`createRun` re-checks status at execution time rather than trusting the scheduler,
because a queue message can be delivered long after it was scheduled — a goal
paused an hour ago may still have a message in flight from before.

Resuming recomputes the firing time **from now**, not from the slot that was
missed. `archived` is terminal: re-activating one would be a re-creation with the
same id and a history that no longer matches, so it is refused.

---

## The service

[`src/lib/goals/service.ts`](../src/lib/goals/service.ts) is the only module that
writes `goals`. There is no exported function that writes a schedule which has not
been through the gate.

| Function | |
|---|---|
| `createGoal` | Validates, then writes. Returns **every** issue, or the goal id. |
| `updateGoal` | Re-runs the *whole* gate. A refused edit changes nothing. |
| `setGoalStatus` | Pause, resume, archive. Resuming recomputes from now. |
| `getGoal` · `listGoals` | Scoped to the owner. |
| `listDueGoals` | The scheduler's query. Repeats the partial index's predicate on purpose. |
| `advanceGoal` | Moves the firing time to the next slot, computed from now. |
| `goalHealth` | Derived from the last run, never denormalised onto the goal. |
| `listRecentRuns` · `listRunSlots` | History. |

`goalHealth` reports `needs_attention` for a `failed` run and a run waiting on
approval alike: a run can fail for a reason no retry will fix — an expired grant, a
revoked scope — and whether to retry that is the user's decision, not the
system's.

A malformed `target_accounts` column must not make a goal unreadable. The goal is
shown with no targets rather than failing to render, because a user who can see
the goal can fix it and a user whose page throws cannot.

---

## Not yet built

- **The Goals dashboard and creation UI** — Phase 7 (v0.9.0). The service above is
  what those screens will call.
- **Plan generation.** Nothing writes `run_steps`; that is Phase 5's planner. Until
  then a fired goal produces a `no_plan` **failure**, not a silent success — a
  no-op that reports success would be the worst outcome available here.
- **Natural-language planning** — Phase 5 (v0.7.0).
