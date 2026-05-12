-- Add currency column to merchants.
-- Default USD for new rows; existing rows get USD too — backfilled by node script after.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS currency VARCHAR(8) NOT NULL DEFAULT 'USD';
CREATE INDEX IF NOT EXISTS idx_merchants_currency ON merchants(currency);
