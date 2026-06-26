-- Vendor wallets + per-verification charging for vendors.
--
-- Vendors become directly billable like merchants: each vendor account gets its
-- own wallet; when one of the vendor's payments is verified, a per-verification
-- fee (admin-set, vendor-specific rate) is debited from the VENDOR's wallet
-- (not the merchant's). Vendors fund the wallet by paying the platform (same
-- flow as activation). A low balance is warned to the vendor in their panel.

-- 1) The vendor wallet lives on the account row.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(14,2) NOT NULL DEFAULT 0;

-- 2) Ledger entries can belong to a vendor account (merchant entries keep it NULL).
ALTER TABLE wallet_ledger ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_account
  ON wallet_ledger(account_id, created_at DESC) WHERE account_id IS NOT NULL;

-- 3) Admin-set, vendor-specific per-verification pricing (mirrors the merchant one).
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS vendor_verify_charge_enabled BOOLEAN      NOT NULL DEFAULT FALSE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS vendor_verify_charge_type    VARCHAR(10)  NOT NULL DEFAULT 'percent';
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS vendor_verify_charge_amount  NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS vendor_verify_charge_percent NUMERIC(7,4)  NOT NULL DEFAULT 0;

-- 4) A platform payment can be a vendor wallet top-up (credits the vendor on success).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vendor_topup_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_vendor_topup
  ON transactions(vendor_topup_account_id) WHERE vendor_topup_account_id IS NOT NULL;

-- 5) Idempotency: credit a given top-up transaction at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_vendor_topup_per_transaction
  ON wallet_ledger(source_transaction_id) WHERE kind = 'vendor_topup' AND source_transaction_id IS NOT NULL;
