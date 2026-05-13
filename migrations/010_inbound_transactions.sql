-- Allow transactions to exist without a checkout session.
-- These represent SMS-driven inbound payments (no customer initiated checkout).
ALTER TABLE transactions ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE transactions ALTER COLUMN brand_id   DROP NOT NULL;

-- The existing FK already cascades on session delete; null is fine.
-- Prevent duplicate inbound entries for the same TxnID per merchant
-- (the existing partial unique index on success-status TxnIDs already covers most cases).
