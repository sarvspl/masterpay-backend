-- Brands: each merchant can have one or more brands (domains), each with its own api_key.
-- merchant_keys keeps only device_auth_key going forward.

CREATE TABLE IF NOT EXISTS brands (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name         VARCHAR(120) NOT NULL,
  domain       VARCHAR(255) NOT NULL,
  api_key      VARCHAR(80)  NOT NULL UNIQUE,
  secret_key   VARCHAR(80)  NOT NULL UNIQUE,
  is_default   BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX        IF NOT EXISTS idx_brands_merchant ON brands(merchant_id);
CREATE INDEX        IF NOT EXISTS idx_brands_api_key  ON brands(api_key);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_brands_default ON brands(merchant_id) WHERE is_default = TRUE;

-- Backfill: each existing merchant gets a default brand carrying their current api_key/secret_key.
-- Wrapped in a column-existence check so the migration stays idempotent after the columns are dropped below.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'merchant_keys' AND column_name = 'api_key'
  ) THEN
    INSERT INTO brands (merchant_id, name, domain, api_key, secret_key, is_default)
    SELECT m.id, m.name, m.domain, k.api_key, k.secret_key, TRUE
      FROM merchants m
      JOIN merchant_keys k ON k.merchant_id = m.id
     WHERE NOT EXISTS (SELECT 1 FROM brands b WHERE b.merchant_id = m.id);
  END IF;
END $$;

-- Drop legacy columns. brand.api_key / brand.secret_key are now the source of truth.
ALTER TABLE merchant_keys DROP COLUMN IF EXISTS api_key;
ALTER TABLE merchant_keys DROP COLUMN IF EXISTS secret_key;
