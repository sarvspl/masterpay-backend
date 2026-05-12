ALTER TABLE merchants ADD COLUMN IF NOT EXISTS is_suspended     BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS suspended_at     TIMESTAMPTZ;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS suspended_reason VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_merchants_suspended ON merchants(is_suspended) WHERE is_suspended = TRUE;
