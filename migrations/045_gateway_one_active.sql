-- One ACTIVE gateway per (account, provider, variant) — but many disabled ones.
--
-- Until now uniq_gateways_account_pair forbade a second row for the same
-- provider+type on an account, so a vendor could hold only one bKash-Agent
-- number, one GPay, etc. The new rule: keep as many numbers as you like, but
-- only one may be ENABLED at a time. Enabling another auto-disables the current
-- one (handled in the controller); the database guarantees the invariant with a
-- PARTIAL unique index that constrains only the enabled rows.
--
-- Safe to run on live data: the old full unique index already guaranteed at most
-- one row per pair (hence at most one enabled), so the partial index can't be
-- violated by anything already stored.
DROP INDEX IF EXISTS uniq_gateways_account_pair;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_gateways_account_active
  ON gateways(account_id, provider, variant)
  WHERE is_enabled = TRUE;
