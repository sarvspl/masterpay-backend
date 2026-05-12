-- SMS messages forwarded from bound Android devices.
-- Every wallet SMS the APK sees gets uploaded here; backend tries to auto-match
-- against pending transactions.

CREATE TABLE IF NOT EXISTS sms_messages (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID         NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  device_id     VARCHAR(255),
  sender        VARCHAR(120) NOT NULL,
  body          TEXT         NOT NULL,
  received_at   TIMESTAMPTZ  NOT NULL,            -- when phone received the SMS
  matched_tx_id UUID         REFERENCES transactions(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX        IF NOT EXISTS idx_sms_merchant_received ON sms_messages(merchant_id, received_at DESC);
CREATE INDEX        IF NOT EXISTS idx_sms_unmatched         ON sms_messages(merchant_id) WHERE matched_tx_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sms_dedup            ON sms_messages(merchant_id, sender, received_at, md5(body));
