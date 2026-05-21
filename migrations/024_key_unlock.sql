-- One-time "integration key unlock" purchase. A merchant must pay a fee from
-- their wallet before their API key / device auth key can be revealed.
--
--   merchants.keys_unlocked   — false until the fee is paid (then keys are
--                               returned by the API; before that they're masked)
--   platform_settings.key_unlock_fee — the one-time fee (admin-configurable,
--                               default 100000; 0 disables the gate entirely)
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS keys_unlocked BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS key_unlock_fee NUMERIC(14,2) NOT NULL DEFAULT 100000;

-- The platform's own merchant is exempt (its keys live in the admin console).
UPDATE merchants SET keys_unlocked = TRUE WHERE is_platform = TRUE;

-- Allow 'key_unlock' as a platform revenue source.
ALTER TABLE platform_revenue DROP CONSTRAINT IF EXISTS platform_revenue_type_chk;
ALTER TABLE platform_revenue
  ADD CONSTRAINT platform_revenue_type_chk
  CHECK (type IN ('verify_fee', 'topup_fee', 'key_unlock'));
