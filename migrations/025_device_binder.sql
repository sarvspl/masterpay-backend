-- Who bound this device + how to reach them on Telegram. Supplied at bind time
-- (POST /api/device/bind). telegram_handle is stored WITHOUT the leading '@';
-- the dashboard links to https://t.me/<handle>.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS binder_name     VARCHAR(120),
  ADD COLUMN IF NOT EXISTS telegram_handle VARCHAR(64);
