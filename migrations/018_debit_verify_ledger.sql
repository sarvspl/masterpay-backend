-- Idempotency guard for the per-verification fee. Each transaction can be
-- debited at most once, even if multiple success hooks fire (e.g. APK report
-- followed by checkoutStatus lazy re-match).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_debit_verify_per_transaction
  ON wallet_ledger(source_transaction_id)
 WHERE kind = 'debit_verify' AND source_transaction_id IS NOT NULL;
