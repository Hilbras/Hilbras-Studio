# Goals

The Goal model. The **table** lands in Phase 1 (v0.3.0); the **goal engine** —
parsing, creation, scheduling, pause/resume — lands in Phase 4 (v0.6.0).

This document describes what exists now, so that Phase 4 has a fixed target to
build against rather than redefining the model as it goes.

---

## The record

`goals` — [`src/db/schema.ts`](../src/db/schema.ts)

| Column | Meaning |
|---|---|
| `id` | Primary key. |
| `user_id` | Owner. Cascades on user delete. |
| `title` | The user's short label, e.g. "Daily AI posts". |
| `statement` | The goal **verbatim**, in the user's own words. |
| `schedule_cron` | Already-validated cron, UTC. |
| `schedule_timezone` | IANA zone the schedule is expressed in. Defaults to `UTC`. |
| `target_accounts` | JSON array of `platform:handle`. |
| `status` | `active` · `paused` · `archived`. |

---

## Three decisions worth knowing

**The statement is kept verbatim.** It is never rewritten or normalised. Phase 4
parses it; Phase 5's planner reads it. Storing the user's actual words means the
planner sees what they meant, and it means the record of *why* a run did
something is preserved even after the parser changes.

**`schedule_cron` holds a validated value, not raw input.** Parsing and
validation happen once, at the edge, before anything is stored. The scheduler
never re-parses user input, so there is exactly one place where a malformed
schedule can be rejected — and exactly one to test.

**`target_accounts` is a list, not a comma-separated string.** This is the
opposite of `posts.platforms`, which is a string and is the reason Phase 2 has
to migrate it. Storing a JSON array of `platform:handle` now means Phase 2 only
replaces the column with a real join, without re-parsing or losing data.

Phase 2 will make this an actual foreign key to the `accounts` table. Until
then the Runtime validates the string against the connected account list before
any plan runs — an unknown account fails the plan, it is never silently
dropped.

---

## Status

| Status | New runs | Existing runs |
|---|---|---|
| `active` | created on each firing | continue |
| `paused` | **refused** — `createRun` throws | continue to completion |
| `archived` | refused | continue to completion |

A paused goal stops *producing* work; it does not abandon a run already in
flight. `createRun` re-checks status at execution time rather than trusting the
scheduler, because a queue message can be delivered long after it was scheduled
— a goal paused an hour ago may still have a message in flight from before.

---

## Not yet built

Everything a user would actually do with a goal:

- creating one from natural language, or editing it
- parsing the statement into a structured target set
- a scheduler that turns `schedule_cron` into runtime events
- goal status history, pause/resume controls
- the Goals dashboard (Phase 7)

A goal row with no scheduler behind it will never fire on its own. The runtime
executes a goal that something else has scheduled.
