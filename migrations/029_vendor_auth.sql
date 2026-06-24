-- Vendor panel login. A "vendor" is an `accounts` row under a merchant (see
-- 026_accounts.sql / 028_vendors.sql). Until now an account had no credentials
-- of its own — it was managed entirely through the merchant dashboard JWT or the
-- marketplace's X-API-Key. This adds a self-service login so each vendor can sign
-- in to their OWN panel and see only their account's stats, transactions,
-- gateways, device key, and APK download.
--
-- Onboarding: the vendor self-registers at /vendor/register using the PV-XXXX
-- device_auth_key the marketplace already handed them, then picks a username +
-- password. No extra work for the marketplace — the device key IS the invite.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS username      VARCHAR(40);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS password_hash VARCHAR(100);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Vendor usernames are unique across all accounts (the vendor login namespace).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_accounts_username
  ON accounts(username)
  WHERE username IS NOT NULL;
