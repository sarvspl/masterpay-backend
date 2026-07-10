-- Merchant → vendor wallet transfer.
--
-- Real-life case: Riya hands GreenBazar 500 in cash. GreenBazar moves 500 from
-- its own MasterPay wallet into Riya's vendor wallet, and keeps the cash. Riya
-- can now cover her per-verification fees.
--
-- Nothing enters or leaves the platform — the money just changes hands
-- internally. Sum of (merchants.wallet_balance + accounts.wallet_balance) is
-- unchanged by a transfer, which is the invariant worth remembering.
--
-- Two wallet_ledger rows are written per transfer, and both are referenced here
-- so the audit trail runs in either direction:
--   merchant side: kind 'vendor_transfer_out', amount = -X
--   vendor side:   kind 'vendor_transfer_in',  amount = +X  (account_id set)
--
-- Credit only. A merchant can put money INTO a vendor's wallet, never take it
-- out: a mistaken debit would knock a trading seller offline at checkout
-- (vendor_wallet_empty) with nothing they could do about it.

CREATE TABLE IF NOT EXISTS vendor_transfers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id        UUID          NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  account_id         UUID          NOT NULL REFERENCES accounts(id)  ON DELETE CASCADE,
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency           VARCHAR(8)    NOT NULL DEFAULT 'BDT',
  note               TEXT,
  merchant_ledger_id BIGINT REFERENCES wallet_ledger(id) ON DELETE SET NULL,
  vendor_ledger_id   BIGINT REFERENCES wallet_ledger(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_transfers_merchant ON vendor_transfers(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_transfers_account  ON vendor_transfers(account_id, created_at DESC);
