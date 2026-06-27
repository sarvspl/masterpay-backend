-- Vendor wallet top-up fee. Mirrors the merchant top-up fee: a % added on top of
-- every vendor recharge. The vendor pays (credit amount + fee), gets the credit
-- amount added to their wallet, and the platform keeps the fee. Own on/off toggle.
--
--   platform_settings.vendor_topup_fee_enabled / _percent — the rate.
--   transactions.vendor_topup_credit_amount — the NET to credit the vendor
--     (transactions.amount stays the GROSS the vendor actually paid, so SMS
--     auto-match still matches what landed on the platform's number).

ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS vendor_topup_fee_enabled BOOLEAN      NOT NULL DEFAULT FALSE;
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS vendor_topup_fee_percent NUMERIC(7,4) NOT NULL DEFAULT 0;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS vendor_topup_credit_amount NUMERIC(14,2);
