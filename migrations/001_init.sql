CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS merchants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(120) NOT NULL,
  username        VARCHAR(80)  NOT NULL UNIQUE,
  password_hash   TEXT         NOT NULL,
  mobile          VARCHAR(20)  NOT NULL,
  domain          VARCHAR(255) NOT NULL,
  industry        VARCHAR(80)  NOT NULL,
  country         VARCHAR(80)  NOT NULL,
  state           VARCHAR(80)  NOT NULL,
  wallet_balance  NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchants_username ON merchants(username);
CREATE INDEX IF NOT EXISTS idx_merchants_mobile   ON merchants(mobile);

CREATE TABLE IF NOT EXISTS merchant_keys (
  merchant_id      UUID PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  api_key          VARCHAR(80)  NOT NULL UNIQUE,
  device_auth_key  VARCHAR(40)  NOT NULL UNIQUE,
  secret_key       VARCHAR(80)  NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_merchant_keys_api ON merchant_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_merchant_keys_auth ON merchant_keys(device_auth_key);

CREATE TABLE IF NOT EXISTS admins (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       VARCHAR(80)  NOT NULL UNIQUE,
  password_hash  TEXT         NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
