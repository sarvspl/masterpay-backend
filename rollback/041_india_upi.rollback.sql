-- Rollback for 041_india_upi.sql
--
-- THIS DIRECTORY IS NOT A MIGRATION DIRECTORY. src/db/migrate.js globs every
-- *.sql in backend/migrations/ and applies it; keeping rollback scripts here
-- stops them from being auto-applied on the next deploy. Run by hand only:
--
--   psql "$DATABASE_URL" -f backend/rollback/041_india_upi.rollback.sql
--
-- You almost certainly do NOT need this. 041 is additive — reverting the app
-- code to the pre-India commit leaves these columns unread and inert. Only run
-- this if you want the schema physically clean.
--
-- WARNING: dropping gateways.vpa destroys every vendor's stored UPI address.
-- Re-onboarding means collecting them all again. Take a backup first:
--   pg_dump "$DATABASE_URL" -t gateways -t providers > pre_rollback_041.sql

BEGIN;

-- Disable rather than delete. transactions.gateway_id is ON DELETE RESTRICT
-- (006_payments.sql), so any UPI gateway that has taken a payment cannot be
-- deleted without destroying its transaction history. Disabled rows are
-- invisible at checkout, which is all the rollback actually needs.
-- gateways.provider has no FK to providers (convention only), so orphaning it
-- is safe.
UPDATE gateways SET is_enabled = FALSE WHERE provider IN ('gpay', 'phonepe');
DELETE FROM providers WHERE id IN ('gpay', 'phonepe');

DROP INDEX IF EXISTS idx_providers_country;

ALTER TABLE gateways  DROP COLUMN IF EXISTS vpa;
ALTER TABLE gateways  DROP COLUMN IF EXISTS bank_code;
ALTER TABLE providers DROP COLUMN IF EXISTS country;

-- Let migrate.js re-apply 041 cleanly if you roll forward again.
DELETE FROM _migrations WHERE name = '041_india_upi.sql';

COMMIT;
