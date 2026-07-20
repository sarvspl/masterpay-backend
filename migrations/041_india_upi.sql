-- India / UPI rails: GPay + PhonePe.
--
-- ADDITIVE ONLY. Every column here is nullable with no default backfill, and no
-- existing row is modified. Reverting the application code leaves these columns
-- unused and harmless — no DB rollback is required. See backend/rollback/041_india_upi.rollback.sql
-- if you genuinely need to drop them (that file lives outside migrations/ on
-- purpose: src/db/migrate.js runs *every* .sql in migrations/).

-- The vendor's UPI address, e.g. 'vendor@okaxis'. Null for non-UPI gateways.
-- Note: gateways.account_number continues to hold the value the SMS matcher looks
-- for. For UPI that is the BANK ACCOUNT last-4 (e.g. '4328'), NOT the VPA — the
-- bank sends the confirmation SMS and never echoes the VPA.
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS vpa VARCHAR(120);

-- Optional. Selects the SMS sender-ID allowlist for this gateway's bank
-- (e.g. 'sbi' -> matches 'JD-SBIUPI-S'). When null the matcher falls back to
-- requiring an alphanumeric DLT sender plus an account-tail match.
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS bank_code VARCHAR(40);

-- NULL = available in every country (all pre-existing providers keep this, so
-- current behaviour is unchanged). A value restricts the provider to that
-- country, matched against merchants.country.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS country VARCHAR(80);

INSERT INTO providers (id, name, initials, color, variants, country) VALUES
  ('gpay',    'Google Pay', 'GP', 'blue',   '["personal"]'::jsonb, 'India'),
  ('phonepe', 'PhonePe',    'Pe', 'indigo', '["personal"]'::jsonb, 'India')
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_providers_country ON providers(country);
