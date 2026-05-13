const pool = require('../db/pool');
const { generateSessionId } = require('../utils/session');

const SESSION_TTL_MIN = 30;

/* ───────────────────────────── MERCHANT-FACING (X-API-Key) */

/**
 * POST /api/payment/sessions
 * Body: { amount, order_id, redirect_url, currency?, customer_phone?, customer_name?, metadata? }
 * Returns: { session_id, checkout_url, expires_at, status }
 */
async function createSession(req, res, next) {
  try {
    const amount        = Number(req.body.amount);
    const order_id      = String(req.body.order_id || '').trim();
    const redirect_url  = String(req.body.redirect_url || '').trim();

    // Currency: explicit > merchant default > USD
    let currency = req.body.currency ? String(req.body.currency).toUpperCase() : null;
    if (!currency) {
      const m = await pool.query('SELECT currency FROM merchants WHERE id = $1', [req.brand.merchant_id]);
      currency = (m.rows[0] && m.rows[0].currency) || 'USD';
    }

    const customer_phone = req.body.customer_phone ? String(req.body.customer_phone).trim() : null;
    const customer_name  = req.body.customer_name ? String(req.body.customer_name).trim() : null;
    const metadata       = req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : null;

    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!order_id)                                return res.status(400).json({ error: 'order_id is required' });
    if (!redirect_url)                            return res.status(400).json({ error: 'redirect_url is required' });
    try { new URL(redirect_url); } catch { return res.status(400).json({ error: 'redirect_url must be a valid URL' }); }

    const id = generateSessionId();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MIN * 60 * 1000);

    await pool.query(
      `INSERT INTO payment_sessions
         (id, merchant_id, brand_id, order_id, amount, currency, customer_phone, customer_name, redirect_url, metadata, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, req.brand.merchant_id, req.brand.brand_id, order_id, amount, currency, customer_phone, customer_name, redirect_url, metadata, expiresAt]
    );

    const baseUrl = process.env.PUBLIC_CHECKOUT_BASE_URL || 'http://localhost:3000';
    res.status(201).json({
      session_id: id,
      checkout_url: `${baseUrl}/pay/${id}`,
      expires_at: expiresAt.toISOString(),
      status: 'pending',
    });
  } catch (e) { next(e); }
}

/**
 * GET /api/payment/sessions/:id  (merchant queries final status)
 */
async function getSessionForMerchant(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT s.*,
              (SELECT row_to_json(t) FROM (
                 SELECT id, txnid_submitted, status, verified_at, result_source
                 FROM transactions
                 WHERE session_id = s.id AND status = 'success'
                 ORDER BY verified_at DESC NULLS LAST LIMIT 1
              ) t) AS successful_transaction
         FROM payment_sessions s
        WHERE s.id = $1 AND s.merchant_id = $2`,
      [req.params.id, req.brand.merchant_id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ session: r.rows[0] });
  } catch (e) { next(e); }
}

/* ───────────────────────────── PUBLIC CHECKOUT (no auth, by session id) */

async function loadSession(sessionId) {
  const r = await pool.query(
    `SELECT s.id, s.amount, s.currency, s.order_id, s.customer_phone, s.customer_name,
            s.redirect_url, s.status, s.expires_at, s.created_at,
            s.merchant_id, s.brand_id,
            m.name AS merchant_name,
            b.name AS brand_name, b.domain AS brand_domain
       FROM payment_sessions s
       JOIN merchants m ON m.id = s.merchant_id
       JOIN brands    b ON b.id = s.brand_id
      WHERE s.id = $1`,
    [sessionId]
  );
  return r.rows[0] || null;
}

async function autoExpire(session) {
  if (session.status === 'pending' && new Date(session.expires_at) < new Date()) {
    await pool.query(
      `UPDATE payment_sessions SET status='expired', updated_at=NOW() WHERE id=$1 AND status='pending'`,
      [session.id]
    );
    session.status = 'expired';
  }
}

async function getCheckoutSession(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    await autoExpire(s);
    res.json({ session: s });
  } catch (e) { next(e); }
}

async function listCheckoutGateways(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });

    const r = await pool.query(
      `SELECT id, provider, variant, account_number, label, min_amount, max_amount,
              charge_value, charge_type, discount_value, discount_type
         FROM gateways
        WHERE merchant_id = $1 AND is_enabled = TRUE
        ORDER BY provider ASC, variant ASC`,
      [s.merchant_id]
    );
    res.json({ gateways: r.rows });
  } catch (e) { next(e); }
}

/**
 * POST /api/checkout/:sessionId/submit
 * Body: { gateway_id, txnid }
 * Creates a transaction row with status='pending'. APK (or manual button) resolves it.
 */
async function submitTxn(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    await autoExpire(s);

    if (s.status !== 'pending') {
      return res.status(409).json({ error: `Session is ${s.status}` });
    }

    const gateway_id = String(req.body.gateway_id || '').trim();
    const txnid      = String(req.body.txnid || '').trim();
    if (!gateway_id) return res.status(400).json({ error: 'gateway_id is required' });
    if (!txnid)      return res.status(400).json({ error: 'Transaction ID is required' });

    // Validate gateway belongs to this merchant
    const g = await pool.query(
      `SELECT id FROM gateways WHERE id = $1 AND merchant_id = $2 AND is_enabled = TRUE`,
      [gateway_id, s.merchant_id]
    );
    if (g.rowCount === 0) return res.status(400).json({ error: 'Invalid gateway for this merchant' });

    // Anti-replay: already used successfully for this merchant?
    const reused = await pool.query(
      `SELECT 1 FROM transactions
        WHERE merchant_id = $1 AND txnid_submitted = $2 AND status = 'success'`,
      [s.merchant_id, txnid]
    );
    if (reused.rowCount > 0) {
      return res.status(409).json({ error: 'This Transaction ID has already been used for another payment.' });
    }

    const r = await pool.query(
      `INSERT INTO transactions
         (session_id, merchant_id, brand_id, gateway_id, txnid_submitted, amount, customer_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, status, created_at`,
      [s.id, s.merchant_id, s.brand_id, gateway_id, txnid, s.amount, s.customer_phone]
    );
    res.status(202).json({ transaction: r.rows[0] });
  } catch (e) { next(e); }
}

/**
 * GET /api/checkout/:sessionId/status
 * Returns: { status, transaction?, redirect_url }
 */
async function checkoutStatus(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    await autoExpire(s);

    // If there's a successful transaction, session is success.
    const tx = await pool.query(
      `SELECT id, txnid_submitted, status, failure_reason, verified_at, result_source
         FROM transactions
        WHERE session_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [s.id]
    );

    let sessionStatus = s.status;
    const lastTx = tx.rows[0] || null;

    // If a transaction succeeded, promote the session status.
    if (lastTx && lastTx.status === 'success' && s.status === 'pending') {
      await pool.query(`UPDATE payment_sessions SET status='success', updated_at=NOW() WHERE id=$1`, [s.id]);
      sessionStatus = 'success';
    }

    res.json({
      status:       sessionStatus,
      transaction:  lastTx,
      redirect_url: s.redirect_url,
    });
  } catch (e) { next(e); }
}

async function cancelCheckout(req, res, next) {
  try {
    const s = await loadSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    if (s.status !== 'pending') return res.json({ ok: true, status: s.status });
    await pool.query(`UPDATE payment_sessions SET status='cancelled', updated_at=NOW() WHERE id=$1`, [s.id]);
    res.json({ ok: true, status: 'cancelled' });
  } catch (e) { next(e); }
}

/* ───────────────────────────── MERCHANT DASHBOARD: list + manual resolve */

async function listTransactions(req, res, next) {
  try {
    const status = req.query.status && ['pending', 'success', 'failed'].includes(req.query.status)
      ? req.query.status : null;
    const q = req.query.q ? String(req.query.q).trim() : null;
    const limit = Math.min(200, Number(req.query.limit) || 50);

    const params = [req.merchant.id];
    let sql = `SELECT t.id, t.session_id, t.txnid_submitted, t.amount, t.status, t.customer_phone,
                      t.result_source, t.verified_at, t.failure_reason, t.created_at,
                      g.provider, g.variant, g.account_number,
                      s.order_id, s.currency AS session_currency
                 FROM transactions t
                 JOIN gateways g ON g.id = t.gateway_id
                 LEFT JOIN payment_sessions s ON s.id = t.session_id
                WHERE t.merchant_id = $1`;
    if (status) { params.push(status); sql += ` AND t.status = $${params.length}`; }
    if (q)      { params.push(`%${q.toLowerCase()}%`); sql += ` AND (LOWER(t.txnid_submitted) LIKE $${params.length} OR LOWER(s.order_id) LIKE $${params.length})`; }
    sql += ` ORDER BY t.created_at DESC LIMIT ${limit}`;

    const r = await pool.query(sql, params);
    res.json({ transactions: r.rows });
  } catch (e) { next(e); }
}

async function manualResolve(req, res, next) {
  try {
    const result = String(req.body.result || '').toLowerCase();
    if (!['success', 'failed'].includes(result)) {
      return res.status(400).json({ error: 'result must be "success" or "failed"' });
    }
    const reason = req.body.reason ? String(req.body.reason).slice(0, 240) : null;

    const r = await pool.query(
      `UPDATE transactions
          SET status = $1,
              result_source = 'manual',
              failure_reason = $2,
              verified_at = NOW(),
              updated_at = NOW()
        WHERE id = $3 AND merchant_id = $4 AND status = 'pending'
        RETURNING id, session_id, status`,
      [result, result === 'failed' ? (reason || 'Manually marked failed') : null, req.params.id, req.merchant.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Pending transaction not found' });

    if (result === 'success') {
      await pool.query(
        `UPDATE payment_sessions SET status='success', updated_at=NOW() WHERE id=$1 AND status='pending'`,
        [r.rows[0].session_id]
      );
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = {
  createSession, getSessionForMerchant,
  getCheckoutSession, listCheckoutGateways, submitTxn, checkoutStatus, cancelCheckout,
  listTransactions, manualResolve,
};
