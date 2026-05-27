-- Accounts: a "receiving unit" under one merchant (one domain / one api_key).
-- Each account has its own device_auth_key and up to 8 gateways (one per
-- provider+variant). The first account per merchant is the Primary (the domain
-- account); additional accounts unlock for a flat 50% of the key-unlock fee.
--
-- The device_auth_key moves from merchant_keys → accounts. merchant_keys is
-- left in place (still mirrors the Primary key for the platform console) but is
-- no longer the source of truth for APK device resolution.

CREATE TABLE IF NOT EXISTS accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID         NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  label           VARCHAR(120) NOT NULL,
  device_auth_key VARCHAR(80)  NOT NULL UNIQUE,
  keys_unlocked   BOOLEAN      NOT NULL DEFAULT FALSE,
  is_default      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX        IF NOT EXISTS idx_accounts_merchant  ON accounts(merchant_id);
CREATE INDEX        IF NOT EXISTS idx_accounts_auth_key  ON accounts(device_auth_key);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_accounts_default  ON accounts(merchant_id) WHERE is_default = TRUE;

-- Seed one Primary account per merchant, reusing the existing device_auth_key
-- and the merchant's current unlock state (so nobody re-pays for what they have).
INSERT INTO accounts (merchant_id, label, device_auth_key, keys_unlocked, is_default)
SELECT m.id, 'Primary', k.device_auth_key, m.keys_unlocked, TRUE
  FROM merchants m
  JOIN merchant_keys k ON k.merchant_id = m.id
 WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.merchant_id = m.id);

-- ── Re-scope gateways → account_id ──
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

-- Backfill every existing gateway onto its merchant's Primary account.
UPDATE gateways g
   SET account_id = a.id
  FROM accounts a
 WHERE a.merchant_id = g.merchant_id
   AND a.is_default = TRUE
   AND g.account_id IS NULL;

ALTER TABLE gateways ALTER COLUMN account_id SET NOT NULL;

-- The cap rule: one gateway per (account, provider, variant). This replaces the
-- old merchant-wide uniqueness so two accounts CAN each hold their own bKash
-- personal number (which is exactly what checkout round-robin alternates).
ALTER TABLE gateways DROP CONSTRAINT IF EXISTS gateways_merchant_id_provider_variant_account_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gateways_account_pair ON gateways(account_id, provider, variant);

CREATE INDEX IF NOT EXISTS idx_gateways_account ON gateways(account_id);

-- Round-robin bookkeeping: checkout stamps NOW() on whichever number it shows,
-- then next time shows the least-recently-shown one of the same provider+variant.
ALTER TABLE gateways ADD COLUMN IF NOT EXISTS last_shown_at TIMESTAMPTZ;

-- ── Re-scope devices → account_id (nullable; old bound devices backfill to Primary) ──
ALTER TABLE devices ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

UPDATE devices d
   SET account_id = a.id
  FROM accounts a
 WHERE a.merchant_id = d.merchant_id
   AND a.is_default = TRUE
   AND d.account_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);
