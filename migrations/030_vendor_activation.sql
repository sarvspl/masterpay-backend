-- Vendor activation paywall. A merchant may require each vendor to pay a
-- one-time activation fee (set per-vendor by the merchant) before the vendor can
-- use their panel. The vendor pays the fee to the MERCHANT's own (Primary)
-- number; it's confirmed by the merchant's phone (SMS auto-match) or by the
-- merchant clicking Activate.
--
--   accounts.activation_fee  — per-vendor fee set by the merchant. 0 = no gate.
--   accounts.activated_at    — set once the fee is confirmed paid (NULL = not yet).
--                              A vendor is GATED iff activation_fee > 0 AND
--                              activated_at IS NULL.
--   transactions.activation_account_id — marks a payment as a vendor-activation
--                              payment (vs a normal customer payment). When such
--                              a transaction flips to success (auto-match or
--                              manual approve), the referenced account is activated.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS activation_fee NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS activated_at   TIMESTAMPTZ;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS activation_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_activation ON transactions(activation_account_id)
  WHERE activation_account_id IS NOT NULL;

-- Grandfather existing vendors: anyone who has already claimed a panel login is
-- treated as activated, so turning on a fee later never locks out a seller who's
-- already operating. The paywall applies only to vendors onboarding from here on.
UPDATE accounts SET activated_at = NOW() WHERE username IS NOT NULL AND activated_at IS NULL;
