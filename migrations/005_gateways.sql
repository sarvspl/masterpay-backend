CREATE TABLE IF NOT EXISTS gateways (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID         NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  provider        VARCHAR(40)  NOT NULL,           -- bkash, rocket, nagad
  variant         VARCHAR(20)  NOT NULL,           -- personal, agent
  account_number  VARCHAR(64)  NOT NULL,
  label           VARCHAR(120),
  min_amount      NUMERIC(14,2),
  max_amount      NUMERIC(14,2),
  charge_value    NUMERIC(14,2),
  charge_type     VARCHAR(10),                     -- fixed, percent
  discount_value  NUMERIC(14,2),
  discount_type   VARCHAR(10),                     -- fixed, percent
  balance_check   BOOLEAN      NOT NULL DEFAULT FALSE,
  is_enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (merchant_id, provider, variant, account_number)
);

CREATE INDEX IF NOT EXISTS idx_gateways_merchant ON gateways(merchant_id);
CREATE INDEX IF NOT EXISTS idx_gateways_provider ON gateways(provider);
