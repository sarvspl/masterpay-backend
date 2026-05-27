-- WhatsApp contact for the person who bound the device — collected at bind time
-- (POST /api/device/bind), alongside binder_name + telegram_handle. Stored as a
-- plain string (digits / +country code); the dashboard links to wa.me/<number>.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(32);
