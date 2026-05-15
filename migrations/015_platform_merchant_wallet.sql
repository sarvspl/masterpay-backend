-- Wallet topup feature: dogfoods PayVerify's own checkout for merchant wallet
-- recharges. A single "platform merchant" row owns the receiving gateways +
-- APK; recharge sessions are regular payment_sessions tagged with metadata
-- that triggers a wallet credit on transaction success.

-- 1. Mark the platform's own merchant row distinctly. Default FALSE so all
--    existing merchants stay "real".
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS is_platform BOOLEAN NOT NULL DEFAULT FALSE;

-- Only one platform merchant ever exists.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_platform_merchant
  ON merchants((is_platform)) WHERE is_platform = TRUE;

-- 2. Seed the singleton platform merchant + its default brand + device key.
--    A junk password_hash that can never match (bcrypt never produces this
--    string), so the login endpoint can't accidentally authenticate against it.
INSERT INTO merchants (
  name, username, password_hash, mobile, email, domain, industry, country, state, currency, is_platform
)
SELECT
  'PayVerify Platform',
  '_platform_system',
  '$NEVER_MATCHES$',
  '+00 0000000000',
  '_platform@payverify.internal',
  'payverify.internal',
  'platform',
  'IN',
  'NA',
  'BDT',
  TRUE
WHERE NOT EXISTS (SELECT 1 FROM merchants WHERE is_platform = TRUE);

-- Default brand for the platform merchant. The api_key is non-secret — the
-- platform's checkout is just any merchant's checkout.
INSERT INTO brands (merchant_id, name, domain, api_key, secret_key, is_default)
SELECT m.id, 'PayVerify Platform', 'payverify.internal',
       'pk_platform_' || md5(random()::text || clock_timestamp()::text),
       'sk_platform_' || md5(random()::text || clock_timestamp()::text),
       TRUE
FROM merchants m
WHERE m.is_platform = TRUE
  AND NOT EXISTS (SELECT 1 FROM brands b WHERE b.merchant_id = m.id);

-- Device auth key so admin's APK can bind to the platform merchant.
INSERT INTO merchant_keys (merchant_id, device_auth_key)
SELECT m.id, 'PV-PLT-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8)
FROM merchants m
WHERE m.is_platform = TRUE
  AND NOT EXISTS (SELECT 1 FROM merchant_keys k WHERE k.merchant_id = m.id);

-- 3. Wallet ledger — auditable record of every credit/debit to merchant balances.
--    Positive amount = credit, negative = debit. Running balance lives on
--    merchants.wallet_balance and is reconstructable from this table.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id                    BIGSERIAL    PRIMARY KEY,
  merchant_id           UUID         NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount                NUMERIC(14,2) NOT NULL,
  kind                  VARCHAR(40)  NOT NULL,  -- 'topup' | 'debit_verify' | 'refund' | 'adjustment'
  source_session_id     VARCHAR(40)            REFERENCES payment_sessions(id) ON DELETE SET NULL,
  source_transaction_id UUID,
  note                  TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_merchant
  ON wallet_ledger(merchant_id, created_at DESC);

-- 4. Dedupe guard: prevent the same successful session from crediting twice
--    if the credit hook is invoked more than once (e.g. retries, race).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wallet_topup_per_session
  ON wallet_ledger(source_session_id) WHERE kind = 'topup';
