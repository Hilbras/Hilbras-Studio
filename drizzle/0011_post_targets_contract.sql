-- Contract `posts.platforms` (ADR-006, architecture §6 resolution 6).
--
-- The comma-separated column is replaced by the `post_targets` join table, which
-- migration 0008 created and backfilled from this very column. This migration
-- finishes the switchover and drops the old column.
--
-- Every step below is ordered so that the column is destroyed last, and each one
-- refuses to continue if the data it depends on is not where it expects. A bare
-- DROP here would be unrecoverable: after it, a post with no target rows has no
-- record anywhere of where it was meant to go.

-- 1. Backfill anything 0008 missed before anything is destroyed.
--
-- 0008 split the column, but a post created between 0008 and the code change
-- that made `post_targets` authoritative would have targets only in the string.
-- Re-derive from the column we are about to drop, so nothing is lost.
INSERT INTO "post_targets" ("post_id", "platform", "account_key")
SELECT p."id", btrim(part.platform), NULL
FROM "posts" p
CROSS JOIN LATERAL unnest(string_to_array(p."platforms", ',')) AS part(platform)
WHERE btrim(part.platform) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "post_targets" t
    WHERE t."post_id" = p."id" AND t."platform" = btrim(part.platform)
  );
--> statement-breakpoint

-- 2. Collapse any duplicates the unconstrained table accumulated.
--
-- Without a unique constraint, two writers could each insert the same
-- `(post_id, platform)`. The read paths report one target per row, so a
-- duplicated row shows a one-platform post as going to three platforms. Keep the
-- lowest ctid, i.e. the earliest insert, and drop the rest.
DELETE FROM "post_targets" t
USING "post_targets" earlier
WHERE t."post_id" = earlier."post_id"
  AND t."platform" = earlier."platform"
  AND t."account_key" IS NOT DISTINCT FROM earlier."account_key"
  AND t.ctid > earlier.ctid;
--> statement-breakpoint

-- 3. Abort unless every post has at least one target.
--
-- The one irreversible step. If this raises, the column is still present and the
-- backfill above can be re-run by hand; there is nothing to restore afterwards.
DO $$
DECLARE
  orphaned integer;
BEGIN
  SELECT count(*) INTO orphaned
  FROM "posts" p
  WHERE NOT EXISTS (SELECT 1 FROM "post_targets" t WHERE t."post_id" = p."id");

  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop posts.platforms: % post(s) have no post_targets row. '
      'Backfill them first — the column is still intact at this point.',
      orphaned;
  END IF;
END $$;
--> statement-breakpoint

-- 4. Enforce one row per (post, platform, account).
--
-- NULLS NOT DISTINCT is required, not decorative: `account_key` is NULL for a
-- platform-level target, and Postgres considers NULLs distinct in a unique index
-- by default, so a plain constraint would let the same (post, platform) in twice.
ALTER TABLE "post_targets"
  ADD CONSTRAINT "post_targets_unique"
  UNIQUE NULLS NOT DISTINCT ("post_id", "platform", "account_key");
--> statement-breakpoint

-- 5. Only now is the old column expendable.
ALTER TABLE "posts" DROP COLUMN "platforms";
