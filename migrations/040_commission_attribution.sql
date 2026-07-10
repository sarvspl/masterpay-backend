-- Merchant commission attribution.
--
-- A marketplace earns a cut of two different platform fees charged to its
-- vendors: the one-time joining (activation) fee, and the per-verification fee.
-- Both land in wallet_ledger as kind='commission', and until now the ONLY way
-- to tell them apart was to string-match the `note`. Worse, a commission booked
-- by admin onboarding carries no source_transaction_id, so it couldn't be traced
-- to the vendor that generated it at all.
--
-- Two new columns make that explicit.
--
-- NOTE the distinction from `account_id`: on wallet_ledger, `account_id` means
-- "this row belongs to that VENDOR's ledger". A merchant's commission row must
-- never set it, or the money would appear in the vendor's wallet history.
-- `commission_account_id` records which vendor the commission CAME FROM, on a
-- row that still belongs to the merchant.

ALTER TABLE wallet_ledger ADD COLUMN IF NOT EXISTS commission_type       VARCHAR(16);
ALTER TABLE wallet_ledger ADD COLUMN IF NOT EXISTS commission_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

ALTER TABLE wallet_ledger DROP CONSTRAINT IF EXISTS wallet_ledger_commission_type_check;
ALTER TABLE wallet_ledger ADD  CONSTRAINT wallet_ledger_commission_type_check
  CHECK (commission_type IS NULL OR commission_type IN ('join', 'verify'));

-- ── Backfill ──
-- Joining commission: the source transaction is the vendor's activation payment,
-- which is tagged with activation_account_id.
UPDATE wallet_ledger l
   SET commission_type = 'join',
       commission_account_id = t.activation_account_id
  FROM transactions t
 WHERE l.kind = 'commission'
   AND l.commission_type IS NULL
   AND t.id = l.source_transaction_id
   AND t.activation_account_id IS NOT NULL;

-- Verification commission: the source transaction is a customer payment, which
-- sits on one of the vendor's gateways.
UPDATE wallet_ledger l
   SET commission_type = 'verify',
       commission_account_id = g.account_id
  FROM transactions t
  JOIN gateways g ON g.id = t.gateway_id
 WHERE l.kind = 'commission'
   AND l.commission_type IS NULL
   AND t.id = l.source_transaction_id
   AND t.activation_account_id IS NULL;

-- Anything still unclassified predates the source_transaction_id link (e.g. an
-- admin-onboarded activation). Fall back to the note, which is all we have.
UPDATE wallet_ledger
   SET commission_type = CASE
         WHEN note ILIKE 'Vendor verification%' THEN 'verify'
         ELSE 'join'
       END
 WHERE kind = 'commission' AND commission_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_commission
  ON wallet_ledger(merchant_id, created_at DESC) WHERE kind = 'commission';
