-- Per-vendor suspension, with a two-level authority.
--
-- Distinct from the merchant-wide suspension in 008 (merchants.is_suspended,
-- which freezes ALL of a marketplace's vendors). This suspends ONE vendor
-- account, and remembers WHO suspended it so the revoke rule can be enforced:
--
--   suspended_by = 'merchant'  → the marketplace suspended its own seller.
--                                Either the merchant OR a superadmin may lift it.
--   suspended_by = 'platform'  → a MasterPay superadmin suspended the seller.
--                                Only a superadmin may lift it; the merchant
--                                sees it suspended but cannot revoke.
--
-- suspended_at IS NULL means "not suspended" — the single source of truth.
--
-- ADDITIVE ONLY: nullable, no backfill, no existing row touched. Reverting the
-- app code leaves these columns unread. See rollback/044_vendor_suspend.rollback.sql.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended_at     TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended_by     VARCHAR(20);   -- 'merchant' | 'platform'
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS suspended_reason VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_accounts_suspended
  ON accounts(suspended_at) WHERE suspended_at IS NOT NULL;
