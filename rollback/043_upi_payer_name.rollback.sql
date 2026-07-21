-- Rollback for 043_upi_payer_name.sql
--
-- NOT a migration directory — src/db/migrate.js applies every *.sql under
-- backend/migrations/, so rollback scripts live here. Run by hand only:
--
--   psql "$DATABASE_URL" -f backend/rollback/043_upi_payer_name.rollback.sql
--
-- READ THIS FIRST. Unlike 041 and 042, this one is NOT purely additive: it
-- restores a NOT NULL on txnid_submitted. Any UPI transaction taken while 043
-- was live has a NULL there, so the ALTER will fail until those rows are dealt
-- with. The script reports them rather than deleting them — they are real
-- payments, and which ones you can afford to lose is not a decision to
-- automate.
--
-- Back up first:
--   pg_dump "$DATABASE_URL" -t transactions > pre_rollback_043.sql

BEGIN;

-- Refuse to run rather than destroy payment history.
DO $$
DECLARE n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM transactions WHERE txnid_submitted IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'Cannot restore NOT NULL: % transaction(s) have no txnid_submitted (UPI payments verified by payer name). Inspect them first: SELECT id, created_at, amount, payer_name_claimed, status FROM transactions WHERE txnid_submitted IS NULL;', n;
  END IF;
END $$;

DROP INDEX IF EXISTS uniq_tx_merchant_fingerprint_success;
DROP INDEX IF EXISTS idx_tx_payer_name_claimed;

ALTER TABLE transactions ALTER COLUMN txnid_submitted SET NOT NULL;

ALTER TABLE transactions DROP COLUMN IF EXISTS payer_name_claimed;
ALTER TABLE transactions DROP COLUMN IF EXISTS match_fingerprint;

DELETE FROM _migrations WHERE name = '043_upi_payer_name.sql';

COMMIT;
