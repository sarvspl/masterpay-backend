-- Merchant commission split. The fees the platform collects from a merchant's
-- vendors (the vendor ACTIVATION fee and the vendor PER-VERIFICATION fee) are
-- shared with the merchant that owns the vendor: the admin sets a commission %
-- that is the MERCHANT's share (credited to the merchant's wallet); the platform
-- keeps the remainder. Each commission can be toggled off independently.

ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS merchant_commission_join_enabled    BOOLEAN      NOT NULL DEFAULT FALSE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS merchant_commission_join_percent     NUMERIC(7,4) NOT NULL DEFAULT 0;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS merchant_commission_verify_enabled   BOOLEAN      NOT NULL DEFAULT FALSE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS merchant_commission_verify_percent   NUMERIC(7,4) NOT NULL DEFAULT 0;

-- Idempotency: credit a merchant commission for a given source fee at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_commission_per_transaction
  ON wallet_ledger(source_transaction_id) WHERE kind = 'commission' AND source_transaction_id IS NOT NULL;
