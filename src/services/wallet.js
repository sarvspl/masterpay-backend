/**
 * Wallet ledger + credit/debit operations.
 *
 * The credit hook is called from every place that flips a transaction.status
 * to 'success'. When the originating session is tagged with
 * metadata.type === 'wallet_topup', we credit the recharge_for_merchant_id's
 * wallet_balance and write a ledger row. Idempotent via a unique index on
 * (source_session_id) WHERE kind = 'topup'.
 */
const pool = require('../db/pool');

/**
 * If `sessionId` belongs to a wallet topup session, credit the originating
 * merchant's wallet. Safe to call from any success path — duplicate calls
 * are no-ops thanks to the partial unique index.
 *
 * Pass an optional `client` if you want this to run inside an existing
 * transaction; otherwise we acquire our own connection.
 *
 * Returns the ledger row that was inserted, or null if nothing to do.
 */
async function creditWalletIfTopup(sessionId, client = null) {
  const runner = client || pool;
  // Load the session + its metadata.
  const s = await runner.query(
    `SELECT id, amount, metadata FROM payment_sessions WHERE id = $1`,
    [sessionId]
  );
  if (s.rowCount === 0) return null;

  const meta = s.rows[0].metadata || {};
  if (meta.type !== 'wallet_topup') return null;

  // merchant_id is a UUID string in this schema. Trim/validate shape.
  const rechargeFor = String(meta.recharge_for_merchant_id || '').trim();
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(rechargeFor)) return null;

  const amount = Number(s.rows[0].amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // Need an actual client for the multi-statement transaction. If the caller
  // didn't give us one, acquire ours and manage BEGIN/COMMIT ourselves.
  const ownsClient = !client;
  const c = client || await pool.connect();
  try {
    if (ownsClient) await c.query('BEGIN');

    // Insert the ledger row first. If a topup ledger for this session already
    // exists, the unique index throws 23505 — we swallow it (idempotent).
    let ledgerRow = null;
    try {
      const ins = await c.query(
        `INSERT INTO wallet_ledger (merchant_id, amount, kind, source_session_id, note)
         VALUES ($1, $2, 'topup', $3, 'Wallet recharge')
         RETURNING id, amount, kind, source_session_id, created_at`,
        [rechargeFor, amount, sessionId]
      );
      ledgerRow = ins.rows[0];
    } catch (e) {
      if (e.code === '23505') {
        if (ownsClient) await c.query('ROLLBACK');
        return null; // already credited — nothing more to do
      }
      throw e;
    }

    // Increment the running total on the merchant.
    await c.query(
      `UPDATE merchants SET wallet_balance = wallet_balance + $1, updated_at = NOW()
        WHERE id = $2`,
      [amount, rechargeFor]
    );

    if (ownsClient) await c.query('COMMIT');
    return ledgerRow;
  } catch (e) {
    if (ownsClient) {
      try { await c.query('ROLLBACK'); } catch {}
    }
    throw e;
  } finally {
    if (ownsClient) c.release();
  }
}

module.exports = { creditWalletIfTopup };
