-- Vendors live in the existing `accounts` table: each "account" under a merchant
-- (one domain / one api_key) is a vendor with its own device_auth_key, devices,
-- and gateways. A marketplace (e.g. abc.com) creates one vendor per seller via
-- POST /api/vendors using its merchant API key.
--
-- This migration adds:
--   1. accounts.external_id — lets the marketplace map our vendor to ITS own
--      seller record, and makes POST /api/vendors idempotent (repeat create with
--      the same external_id returns the same vendor + device key).
--   2. payment_sessions.account_id — scopes a checkout to a single vendor: only
--      that vendor's gateways are shown, the transaction lands on that vendor's
--      gateway, and (via the already-account-scoped device poll + push) only
--      that vendor's phone(s) are notified. NULL keeps the legacy whole-merchant
--      behaviour so existing single-seller integrations are unaffected.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS external_id VARCHAR(120);

-- One external_id per merchant (when set). Backs idempotent vendor creation.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_accounts_external
  ON accounts(merchant_id, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE payment_sessions
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payment_sessions_account ON payment_sessions(account_id);
