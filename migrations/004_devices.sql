CREATE TABLE IF NOT EXISTS devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  device_id     VARCHAR(255) NOT NULL,            -- stable identifier from the APK
  model         VARCHAR(120),
  manufacturer  VARCHAR(80),
  os_version    VARCHAR(40),
  device_token  TEXT,                              -- FCM token (for push delivery)
  is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (merchant_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_merchant ON devices(merchant_id);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen_at);
