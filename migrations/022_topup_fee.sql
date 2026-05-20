-- Platform top-up fee + platform revenue ledger.
--
-- 1. A configurable fee charged on every wallet recharge, ADDED ON TOP of the
--    amount the merchant wants credited (they pay credit + fee; we credit the
--    net). Defaults to enabled at 1%.
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS topup_fee_enabled BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS topup_fee_percent NUMERIC(7,4) NOT NULL DEFAULT 1.00;

-- 2. Platform revenue ledger — every bit of platform income, so the super
--    admin can see how much was earned and where it came from. Positive
--    amounts only (income). Running totals are reconstructable from this table.
CREATE TABLE IF NOT EXISTS platform_revenue (
  id                    BIGSERIAL     PRIMARY KEY,
  type                  VARCHAR(20)   NOT NULL,            -- 'verify_fee' | 'topup_fee'
  amount                NUMERIC(14,2) NOT NULL,            -- income, always > 0
  currency              VARCHAR(3)    NOT NULL DEFAULT 'BDT',
  merchant_id           UUID          REFERENCES merchants(id) ON DELETE SET NULL,
  source_transaction_id UUID,                              -- set for verify_fee
  source_session_id     VARCHAR(40)   REFERENCES payment_sessions(id) ON DELETE SET NULL, -- set for topup_fee
  note                  TEXT,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_revenue_type_chk CHECK (type IN ('verify_fee', 'topup_fee'))
);
CREATE INDEX IF NOT EXISTS idx_platform_revenue_created ON platform_revenue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_revenue_merchant ON platform_revenue(merchant_id);

-- Idempotency: a verify fee is earned at most once per transaction, a top-up
-- fee at most once per recharge session — mirroring the wallet_ledger guards.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_revenue_verify_per_tx
  ON platform_revenue(source_transaction_id)
 WHERE type = 'verify_fee' AND source_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_revenue_topup_per_session
  ON platform_revenue(source_session_id)
 WHERE type = 'topup_fee' AND source_session_id IS NOT NULL;
