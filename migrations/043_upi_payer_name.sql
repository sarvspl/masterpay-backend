-- Verify UPI payments by the payer's NAME instead of a transaction ID.
--
-- GPay and PhonePe bury the 12-digit UTR several screens deep, and customers
-- either can't find it or mistype it. The vendor's phone, however, gets an
-- app notification naming the payer the moment money lands — so the customer
-- only has to say who they are.
--
-- REPLACING THE REPLAY GUARD. txnid_submitted was doing two jobs: identifying
-- the payment, and (via uniq_tx_merchant_txnid_success) stopping one payment
-- settling two orders. Dropping it for UPI would drop the second job too, so
-- match_fingerprint takes over: it identifies the specific SMS/notification
-- that settled a transaction, and the partial unique index below makes the
-- database refuse to let one of them settle a second order. A loser of that
-- race stays pending and goes to manual review, which is the safe outcome.
--
-- ADDITIVE except for relaxing a NOT NULL, which no existing row relies on.
-- See backend/rollback/043_upi_payer_name.rollback.sql.

-- What the customer typed at checkout, for UPI. Compared against the payer name
-- in the app notification. NOT the same as payer_name, which holds the name
-- PARSED OUT of a matched SMS after the fact.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payer_name_claimed VARCHAR(120);

-- Identifies the SMS/notification that settled this transaction. Set by the
-- device when it reports a match.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS match_fingerprint VARCHAR(64);

-- UPI transactions carry a name rather than a TxnID.
ALTER TABLE transactions ALTER COLUMN txnid_submitted DROP NOT NULL;

-- One payment settles at most one order. The partial index means pending and
-- failed rows are unconstrained, and NULL fingerprints (every wallet payment,
-- which is still protected by uniq_tx_merchant_txnid_success) are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tx_merchant_fingerprint_success
  ON transactions (merchant_id, match_fingerprint)
  WHERE status = 'success' AND match_fingerprint IS NOT NULL;

-- Finding the pending UPI rows a notification could settle.
CREATE INDEX IF NOT EXISTS idx_tx_payer_name_claimed
  ON transactions (merchant_id, payer_name_claimed)
  WHERE status = 'pending' AND payer_name_claimed IS NOT NULL;
