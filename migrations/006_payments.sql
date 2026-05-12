-- Payment sessions: created by merchant via API, customer pays through PayVerify-hosted page.
CREATE TABLE IF NOT EXISTS payment_sessions (
  id               VARCHAR(32)   PRIMARY KEY,        -- short URL-safe id used in checkout_url
  merchant_id      UUID          NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  brand_id         UUID          NOT NULL REFERENCES brands(id)    ON DELETE CASCADE,
  order_id         VARCHAR(120)  NOT NULL,           -- merchant's own order reference
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency         VARCHAR(8)    NOT NULL DEFAULT 'USD',
  customer_phone   VARCHAR(40),
  customer_name    VARCHAR(120),
  redirect_url     TEXT          NOT NULL,
  status           VARCHAR(20)   NOT NULL DEFAULT 'pending',
                                                     -- pending | success | failed | cancelled | expired
  metadata         JSONB,
  expires_at       TIMESTAMPTZ   NOT NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pay_sessions_merchant ON payment_sessions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_pay_sessions_status   ON payment_sessions(status);

-- Transactions: one row per customer attempt (TxnID submission) on a session.
-- A session may have multiple failed attempts followed by a success.
CREATE TABLE IF NOT EXISTS transactions (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        VARCHAR(32)   NOT NULL REFERENCES payment_sessions(id) ON DELETE CASCADE,
  merchant_id       UUID          NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  brand_id          UUID          NOT NULL REFERENCES brands(id)    ON DELETE CASCADE,
  gateway_id        UUID          NOT NULL REFERENCES gateways(id)  ON DELETE RESTRICT,
  txnid_submitted   VARCHAR(120)  NOT NULL,
  amount            NUMERIC(14,2) NOT NULL,
  customer_phone    VARCHAR(40),
  status            VARCHAR(20)   NOT NULL DEFAULT 'pending',
                                                          -- pending | success | failed
  result_source     VARCHAR(20),                          -- apk | manual | timeout
  result_device_id  VARCHAR(255),
  matched_sms       TEXT,
  failure_reason    VARCHAR(255),
  verified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX        IF NOT EXISTS idx_tx_session         ON transactions(session_id);
CREATE INDEX        IF NOT EXISTS idx_tx_merchant_status ON transactions(merchant_id, status);
CREATE INDEX        IF NOT EXISTS idx_tx_status_pending  ON transactions(status) WHERE status = 'pending';

-- Anti-replay: once a TxnID has been used SUCCESSFULLY for a merchant, it can't be reused.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tx_merchant_txnid_success
  ON transactions(merchant_id, txnid_submitted) WHERE status = 'success';
