-- Rollback for 042_charged_currency.sql
--
-- NOT a migration directory — src/db/migrate.js applies every *.sql in
-- backend/migrations/, so rollback scripts live here to stay out of its way.
-- Run by hand only:
--
--   psql "$DATABASE_URL" -f backend/rollback/042_charged_currency.rollback.sql
--
-- 042 is additive, so reverting the app code leaves this column unread and
-- inert. Only run this if you want the schema physically clean.
--
-- WARNING: dropping charged_currency loses the record of which currency each
-- cross-rail payment was actually taken in. That is the only place that fact is
-- stored — the session records what was *invoiced*, not what was *charged*.
-- Back it up first if you have any such payments:
--   pg_dump "$DATABASE_URL" -t transactions > pre_rollback_042.sql

BEGIN;

ALTER TABLE transactions DROP COLUMN IF EXISTS charged_currency;

DELETE FROM _migrations WHERE name = '042_charged_currency.sql';

COMMIT;
