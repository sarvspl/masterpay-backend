-- Rollback for 044_vendor_suspend.sql
--
-- NOT a migration directory — src/db/migrate.js applies every *.sql in
-- backend/migrations/, so rollback scripts live here. Run by hand only:
--   psql "$DATABASE_URL" -f backend/rollback/044_vendor_suspend.rollback.sql
--
-- 044 is additive, so reverting the app code leaves these columns inert. Only
-- run this to make the schema physically clean. It drops the record of which
-- vendors were suspended and by whom — back up first if that matters.

BEGIN;

DROP INDEX IF EXISTS idx_accounts_suspended;

ALTER TABLE accounts DROP COLUMN IF EXISTS suspended_at;
ALTER TABLE accounts DROP COLUMN IF EXISTS suspended_by;
ALTER TABLE accounts DROP COLUMN IF EXISTS suspended_reason;

DELETE FROM _migrations WHERE name = '044_vendor_suspend.sql';

COMMIT;
