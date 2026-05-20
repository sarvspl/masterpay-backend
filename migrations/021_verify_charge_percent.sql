-- Let the platform admin charge the per-verification fee either as a flat
-- amount (the original behaviour) or as a percentage of the incoming payment.
--
--   verify_charge_type = 'fixed'   → debit verify_charge_amount (flat)
--   verify_charge_type = 'percent' → debit verify_charge_percent % of the
--                                     verified payment amount, rounded to 2dp
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS verify_charge_type    VARCHAR(10)   NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS verify_charge_percent NUMERIC(7,4)  NOT NULL DEFAULT 0;

-- Guard the type to the two values the app understands.
ALTER TABLE platform_settings
  DROP CONSTRAINT IF EXISTS platform_settings_charge_type_chk;
ALTER TABLE platform_settings
  ADD CONSTRAINT platform_settings_charge_type_chk
  CHECK (verify_charge_type IN ('fixed', 'percent'));
