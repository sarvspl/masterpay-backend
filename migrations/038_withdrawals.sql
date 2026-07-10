-- Merchant wallet withdrawals.
--
-- A marketplace's wallet only ever grows now (commission from its vendors'
-- fees). This is the first way money leaves it, so it needs a paper trail.
--
-- MONEY FLOW — the balance is held at REQUEST time, not at approval:
--   request  → wallet_ledger row of -amount (kind 'withdrawal'), balance drops
--   approve  → nothing moves; the payout happened off-platform
--   reject   → wallet_ledger row of +amount (kind 'withdrawal_refund'), balance restored
--
-- Holding at request is what stops a merchant with 100 filing five 100 requests
-- and having all five approved. The balance a merchant sees is always spendable.

CREATE TABLE IF NOT EXISTS withdrawals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID          NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency        VARCHAR(8)    NOT NULL DEFAULT 'BDT',

  -- 'bank' = bank account, 'mobile' = mobile banking (bKash / Nagad / …)
  method          VARCHAR(16)   NOT NULL CHECK (method IN ('bank', 'mobile')),

  -- Common to both. account_number is the bank account or the wallet number.
  account_holder  VARCHAR(120)  NOT NULL,
  account_number  VARCHAR(64)   NOT NULL,

  -- Bank only
  bank_name       VARCHAR(120),
  branch          VARCHAR(120),
  routing_number  VARCHAR(40),

  -- Mobile only. provider/variant mirror the `providers` catalog (bkash/personal…)
  provider        VARCHAR(40),
  variant         VARCHAR(20),

  status          VARCHAR(16)   NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'rejected')),
  merchant_note   TEXT,
  admin_note      TEXT,         -- rejection reason, or payout reference on approve
  payout_reference TEXT,        -- TxnID / bank reference the admin paid with

  -- Ledger rows this request created, so the audit trail is two-way.
  hold_ledger_id   BIGINT REFERENCES wallet_ledger(id) ON DELETE SET NULL,
  refund_ledger_id BIGINT REFERENCES wallet_ledger(id) ON DELETE SET NULL,

  requested_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     VARCHAR(80),  -- admin username

  -- A bank withdrawal needs a bank name; a mobile one needs provider + variant.
  CONSTRAINT withdrawal_method_fields CHECK (
    (method = 'bank'   AND bank_name IS NOT NULL)
    OR
    (method = 'mobile' AND provider IS NOT NULL AND variant IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_merchant ON withdrawals(merchant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status   ON withdrawals(status, requested_at DESC);

-- wallet_ledger.kind is a free VARCHAR(40); the two new kinds are
-- 'withdrawal' (negative) and 'withdrawal_refund' (positive).
