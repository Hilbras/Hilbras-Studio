-- Preflight for 0017_state_checks.sql
--
-- Why this file exists
-- --------------------
-- 0017 adds CHECK constraints to four state columns. The constraints are
-- additive and cannot lose data, but they can FAIL TO APPLY if a row already
-- holds a value outside the allowed set — and that value would then be a
-- corrupt row that no reader knows how to interpret, which is the exact thing
-- the constraints exist to prevent.
--
-- So run this first, against the database you are about to migrate. Each query
-- is SELECT-only and changes nothing.
--
--   psql "$DATABASE_URL" -f drizzle/0017_state_checks.preflight.sql
--
-- Every query below must return **zero rows**. There is no `IS NULL` branch:
-- all four columns are `NOT NULL` in the schema, so a null cannot reach them. A non-empty result names the
-- offending rows: correct them (or decide the vocabulary is wrong) before
-- applying 0017. Do not widen the CHECK to accommodate a bad row — that
-- discards the guarantee this migration is for.
--
-- The vocabularies below are copied verbatim from 0017_state_checks.sql. If you
-- change one, change it in both files.

-- 1. goals.status must be one of active | paused | archived
SELECT id, status
  FROM "goals"
 WHERE "status" NOT IN ('active', 'paused', 'archived');

-- 2. run_step_approvals.state must be one of pending | approved | rejected | expired
SELECT id, state
  FROM "run_step_approvals"
 WHERE "state" NOT IN ('pending', 'approved', 'rejected', 'expired');

-- 3. run_steps.state must be one of
--    pending | running | awaiting_approval | completed | failed | cancelled
SELECT id, state
  FROM "run_steps"
 WHERE "state" NOT IN ('pending', 'running', 'awaiting_approval',
                       'completed', 'failed', 'cancelled');

-- 4. runs.state — same vocabulary as run_steps.state
SELECT id, state
  FROM "runs"
 WHERE "state" NOT IN ('pending', 'running', 'awaiting_approval',
                       'completed', 'failed', 'cancelled');

-- ---------------------------------------------------------------------------
-- Summary
--
-- Past this point every query above must return no rows. The count of rows
-- returned by each is the number of rows that will block 0017.
--
-- Note: this preflight has been run only against a development database, as
-- part of the migration's own tests. It has never been run against production
-- data, because that is not possible from the development environment. Treat
-- the first production run as the real one.