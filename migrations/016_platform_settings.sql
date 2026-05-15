-- Platform-wide settings managed by super admin. Singleton row (id=1).
-- First setting: the per-verification fee debited from each merchant's wallet
-- when a transaction successfully verifies.
CREATE TABLE IF NOT EXISTS platform_settings (
  id                      SMALLINT PRIMARY KEY DEFAULT 1,
  verify_charge_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,    -- 0 = free, no debit
  verify_charge_currency  VARCHAR(3)    NOT NULL DEFAULT 'BDT',
  verify_charge_enabled   BOOLEAN       NOT NULL DEFAULT FALSE,
  low_balance_threshold   NUMERIC(14,2) NOT NULL DEFAULT 0,    -- merchant gets warned below this
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_settings_singleton CHECK (id = 1)
);

-- Seed the single row so callers can always UPDATE without checking existence.
INSERT INTO platform_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
