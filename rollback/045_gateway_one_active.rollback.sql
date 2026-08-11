-- Reverse 045: back to one row per (account, provider, variant), enabled or not.
--
-- WARNING: only safe if every account currently holds at most one gateway per
-- provider+variant. If any account has added extra (disabled) numbers under the
-- new model, recreating the full unique index will fail — collapse those to one
-- row per pair first.
DROP INDEX IF EXISTS uniq_gateways_account_active;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_gateways_account_pair
  ON gateways(account_id, provider, variant);
