-- Contract `social_accounts` (ADR-006, architecture §6 resolution 6).
--
-- Every row was copied into `connections` + `accounts` by migration 0008. The
-- guards below re-verify that before anything is destroyed, because this is the
-- one irreversible step in the ADR-006 migration chain: if 0008 was skipped or
-- partially applied, a bare DROP would silently delete every OAuth token with no
-- way back.
--
-- Abort rather than drop if the backfill is incomplete. Restoring `social_accounts`
-- from `accounts` + `connections` is possible; restoring it after a drop is not.
DO $$
DECLARE
  legacy_rows integer;
  migrated_rows integer;
BEGIN
  SELECT count(*) INTO legacy_rows FROM "social_accounts";
  SELECT count(*) INTO migrated_rows FROM "accounts";

  IF migrated_rows < legacy_rows THEN
    RAISE EXCEPTION
      'Refusing to drop social_accounts: % rows exist but only % accounts were '
      'backfilled. Run 0008_accounts_and_connections first.',
      legacy_rows, migrated_rows;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE "social_accounts" CASCADE;
