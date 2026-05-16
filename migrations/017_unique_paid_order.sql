-- An order can have many sessions (retries after expiry/failure), but only
-- ONE of them is ever allowed to reach status='success'. This is the DB-level
-- safety net for the application-level dedup logic in createSession.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_paid_session_per_order
  ON payment_sessions(merchant_id, order_id) WHERE status = 'success';
