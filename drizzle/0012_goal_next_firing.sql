-- Phase 4: let the scheduler find a due goal without evaluating every goal's cron.
--
-- `next_firing_at` is derived state, not a source of truth. `schedule_cron` and
-- `schedule_timezone` are, and the goal service recomputes this column whenever
-- either changes. It exists so the scheduler's query is
--
--     WHERE status = 'active' AND next_firing_at <= now()
--
-- an index scan, instead of parsing and evaluating every active goal's cron on
-- every tick. Doing the latter would mean reimplementing cron *and* DST
-- arithmetic in SQL — precisely the work `lib/goals/cron.ts` already does, and
-- does with tests named after the DST cases.
--
-- timestamptz, unlike every other timestamp in this schema, on purpose. This
-- column holds an absolute instant and is compared against `now()`; a bare
-- `timestamp` is stored and returned in whatever TimeZone the session happens
-- to have, so the same row would read differently depending on which pooled
-- connection served the query.

-- 1. The column, nullable.
--
-- Nullable because "not active" and "not yet scheduled" are both real states,
-- and a paused goal genuinely has no next firing. A NOT NULL column would force
-- a sentinel instant that the scheduler would then have to special-case.
ALTER TABLE "goals" ADD COLUMN "next_firing_at" timestamp with time zone;
--> statement-breakpoint

-- 2. Backfill before the index exists.
--
-- Every active goal is treated as due immediately, and `now()` is the correct
-- value rather than a guess: a goal whose next firing has already passed *is*
-- due, and nothing in the schema records whether it was ever served. Skipping
-- this would leave every pre-existing active goal with a NULL and therefore
-- permanently unscheduled — a goal that looks configured and never runs, which
-- is the worst failure mode available to a scheduler.
--
-- Computing the true next slot is not possible here, and that is the point of
-- this column: it would require a cron evaluator in SQL.
--
-- Only active rows. A paused or archived goal keeps NULL, which the partial
-- index below excludes anyway — so the two are consistent, and no future edit
-- to the predicate can pick up a goal that was deliberately put on hold.
UPDATE "goals" SET "next_firing_at" = now() WHERE "status" = 'active';
--> statement-breakpoint

-- 3. The scheduler's only index, created after the backfill.
--
-- After the backfill rather than before, so the UPDATE above is a plain heap
-- write with no index maintenance. On a table this size it is microseconds, but
-- the ordering costs nothing and removes a question later.
--
-- Partial on `status = 'active'`: a paused goal has a NULL firing time and is
-- never due, so indexing those rows would only bloat the index on a table where
-- most goals are paused most of the time.
CREATE INDEX "goals_due_idx" ON "goals" USING btree ("next_firing_at") WHERE "goals"."status" = 'active';
