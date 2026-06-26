-- Vendor activation fee is now a PLATFORM (admin-set) fee, not a per-vendor
-- merchant fee. One global amount applies to every vendor; the vendor pays the
-- PLATFORM's receiving number and the admin (or the platform's phone via SMS
-- auto-match) confirms it. It becomes platform revenue.
--
--   platform_settings.vendor_activation_fee — global one-time fee (0 = no gate).
--   platform_revenue.type now also allows 'vendor_activation'.
--
-- The per-vendor accounts.activation_fee column from 030 is left in place but is
-- no longer read by the gate (kept to avoid a destructive drop).

ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS vendor_activation_fee NUMERIC(14,2) NOT NULL DEFAULT 0;

ALTER TABLE platform_revenue DROP CONSTRAINT IF EXISTS platform_revenue_type_chk;
ALTER TABLE platform_revenue
  ADD CONSTRAINT platform_revenue_type_chk
  CHECK (type IN ('verify_fee', 'topup_fee', 'key_unlock', 'vendor_activation'));
