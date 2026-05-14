-- Soft-delete devices instead of hard DELETE on unbind, so the history is preserved.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS unbound_at     TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS unbound_reason VARCHAR(40);
                                                  -- 'apk_unbind' | 'merchant_delete' | 'admin'

-- Drop the original UNIQUE so historical rows can coexist with an active row for the same device_id.
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_merchant_id_device_id_key;

-- Only ONE ACTIVE row per (merchant_id, device_id). Unbound history rows are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_devices_active
  ON devices(merchant_id, device_id) WHERE unbound_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_devices_unbound ON devices(merchant_id, unbound_at) WHERE unbound_at IS NOT NULL;
