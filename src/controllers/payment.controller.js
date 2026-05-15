const pool = require('../db/pool');
const { generateSessionId } = require('../utils/session');
const { notifyVerifyRequest } = require('../utils/push');
const smsCtrl = require('./sms.controller');
const { creditWalletIfTopup } = require('../services/wallet');

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
 *
 * Resolution order:
 *   1. If an SMS already received for this merchant contains this TxnID and
 *      the amount/gateway matches → create a success transaction immediately.
 *   2. If an "inbound" success transaction already exists for this TxnID
 *      (i.e. SMS arrived first and created its own row with no session_id) →
 *      claim it for this session.
 *   3. If this TxnID was already used on a DIFFERENT session → reject (anti-replay).
 *   4. Otherwise insert a pending transaction and ping the merchant's APK(s)
 *      via FCM so they can approve/reject from the phone.
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
      `SELECT id, provider, variant, account_number, label
         FROM gateways WHERE id = $1 AND merchant_id = $2 AND is_enabled = TRUE`,
      [gateway_id, s.merchant_id]
    );
    if (g.rowCount === 0) return res.status(400).json({ error: 'Invalid gateway for this merchant' });
    const gateway = g.rows[0];

    /* ─── (0) Idempotency: this merchant already has a transaction for this TxnID ─── */
    //
    //   A TxnID is supposed to be globally unique (it's a wallet transaction id),
    //   so seeing one twice is either a retry / accidental double-submit, or an
    //   attempt to reuse one payment for two orders. Either way we never want a
    //   second row — return whatever state the first one is in.
    const existing = await pool.query(
      `SELECT id, session_id, status, amount, created_at, failure_reason
         FROM transactions
        WHERE merchant_id = $1 AND LOWER(txnid_submitted) = LOWER($2)
        ORDER BY created_at DESC LIMIT 1`,
      [s.merchant_id, txnid]
    );
    if (existing.rowCount > 0) {
      const e = existing.rows[0];

      // Same session → idempotent retry.
      if (e.session_id === s.id) {
        return res.status(200).json({ transaction: e, duplicate_submit: true });
      }

      // Inbound success (no session yet) with matching amount → fall through to Path A claim logic.
      const isClaimableInbound =
        e.status === 'success' && e.session_id === null && Number(e.amount) === Number(s.amount);
      if (!isClaimableInbound) {
        // Anything else: this TxnID is already accounted for on another order.
        // Return the existing transaction's state instead of creating a duplicate.
        return res.status(409).json({
          error:
            e.status === 'success' ? 'This Transaction ID has already been used for another payment.' :
            e.status === 'failed'  ? 'This Transaction ID was already rejected. Please use a fresh transaction.' :
            /* pending */            'This Transaction ID is already being verified for another order.',
          existing_status: e.status,
          transaction: e,
        });
      }
    }

    /* ─── (A) Claim an inbound success that arrived from SMS already ─── */
    //
    //   tryCreateInbound() may have already created a success row with
    //   matched_sms set and session_id NULL. If its TxnID matches what the
    //   customer just typed, link it to this session.
    const inbound = await pool.query(
      `SELECT id, amount FROM transactions
        WHERE merchant_id = $1
          AND LOWER(txnid_submitted) = LOWER($2)
          AND status = 'success'
          AND session_id IS NULL
        LIMIT 1`,
      [s.merchant_id, txnid]
    );
    if (inbound.rowCount > 0) {
      // Sanity: amount must match the session amount (don't claim someone else's payment)
      if (Number(inbound.rows[0].amount) === Number(s.amount)) {
        const upd = await pool.query(
          `UPDATE transactions
              SET session_id = $1, brand_id = $2, customer_phone = COALESCE(customer_phone, $3), updated_at = NOW()
            WHERE id = $4
            RETURNING id, status, created_at`,
          [s.id, s.brand_id, s.customer_phone, inbound.rows[0].id]
        );
        await pool.query(
          `UPDATE payment_sessions SET status='success', updated_at=NOW() WHERE id=$1 AND status='pending'`,
          [s.id]
        );
        await creditWalletIfTopup(s.id).catch((e) => console.error('[wallet] credit failed (inbound claim):', e.message));
        return res.status(200).json({ transaction: upd.rows[0], auto_matched: 'inbound' });
      }
    }

    /* ─── (B) Anti-replay: handled by Path (0). ─── */

    /* ─── (C) Late match: search received SMS for this TxnID ─── */
    //
    //   The SMS might be in sms_messages but unmatched (e.g. amount parser
    //   missed it). Walk the last 15 minutes and try a strict match.
    const smsRows = await pool.query(
      `SELECT id, body FROM sms_messages
        WHERE merchant_id = $1
          AND received_at > NOW() - INTERVAL '15 minutes'
          AND LOWER(body) LIKE LOWER('%' || $2 || '%')
        ORDER BY received_at DESC
        LIMIT 5`,
      [s.merchant_id, txnid]
    );
    for (const sms of smsRows.rows) {
      // Reject debit SMS
      if (smsCtrl.extractDirection(sms.body) === 'debit') continue;
      // Must reference THIS gateway's account
      const matchedGw = smsCtrl.findGatewayInSms(sms.body, [gateway]);
      if (!matchedGw) continue;
      // Strict txnid + amount check
      const ok = smsCtrl.smsMatchesTransaction(sms.body, {
        txnid_submitted: txnid,
        amount: s.amount,
        customer_phone: null,         // session phone is optional / often missing in SMS
      });
      if (!ok) continue;

      const payer = smsCtrl.extractPayer(sms.body);
      const ins = await pool.query(
        `INSERT INTO transactions
           (session_id, merchant_id, brand_id, gateway_id, txnid_submitted, amount, customer_phone,
            status, result_source, matched_sms, verified_at, payer_name, payer_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'success','sms_late_match',$8,NOW(),$9,$10)
         RETURNING id, status, created_at`,
        [s.id, s.merchant_id, s.brand_id, gateway.id, txnid, s.amount, s.customer_phone,
         sms.body, payer.name, payer.phone]
      );
      await pool.query(`UPDATE sms_messages SET matched_tx_id = $1 WHERE id = $2`, [ins.rows[0].id, sms.id]);
      await pool.query(
        `UPDATE payment_sessions SET status='success', updated_at=NOW() WHERE id=$1 AND status='pending'`,
        [s.id]
      );
      await creditWalletIfTopup(s.id).catch((e) => console.error('[wallet] credit failed (late sms):', e.message));
      return res.status(200).json({ transaction: ins.rows[0], auto_matched: 'sms' });
    }

    /* ─── (D) No auto-match — create pending and ping the APK(s) ─── */
    const r = await pool.query(
      `INSERT INTO transactions
         (session_id, merchant_id, brand_id, gateway_id, txnid_submitted, amount, customer_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, status, created_at`,
      [s.id, s.merchant_id, s.brand_id, gateway.id, txnid, s.amount, s.customer_phone]
    );

    // Fire-and-forget — never block the customer's response on push delivery
    notifyVerifyRequest(s.merchant_id, {
      verification_id: r.rows[0].id,
      txnid,
      amount:          Number(s.amount).toFixed(2),
      currency:        s.currency,
      provider:        gateway.provider,
      account_number:  gateway.account_number,
      customer_phone:  s.customer_phone,
      customer_name:   s.customer_name,
      order_id:        s.order_id,
      created_at:      r.rows[0].created_at,
    }).catch((e) => console.warn('[push] notifyVerifyRequest failed:', e.message));

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
      await creditWalletIfTopup(s.id).catch((e) => console.error('[wallet] credit failed (status promo):', e.message));
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
                      t.payer_name, t.payer_phone,
                      g.provider, g.variant, g.account_number, g.label AS gateway_label,
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

    // Lookup the target row first so we can detect the dupe-success case
    // (another row with the same TxnID is already success) BEFORE the UPDATE
    // would fail at the partial unique index `uniq_tx_merchant_txnid_success`.
    const target = await pool.query(
      `SELECT id, session_id, status, txnid_submitted
         FROM transactions WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, req.merchant.id]
    );
    if (target.rowCount === 0) return res.status(404).json({ error: 'Transaction not found' });
    if (target.rows[0].status !== 'pending') {
      return res.status(409).json({
        error: `Transaction already ${target.rows[0].status}.`,
        existing_status: target.rows[0].status,
      });
    }

    // If marking success, check for an existing success row with the same TxnID.
    // Surface it as a graceful response instead of leaking the unique-violation.
    if (result === 'success') {
      const dup = await pool.query(
        `SELECT id, session_id FROM transactions
          WHERE merchant_id = $1
            AND LOWER(txnid_submitted) = LOWER($2)
            AND status = 'success'
          LIMIT 1`,
        [req.merchant.id, target.rows[0].txnid_submitted]
      );
      if (dup.rowCount > 0) {
        return res.status(409).json({
          error: 'This Transaction ID is already marked Paid on another order.',
          existing_success_id: dup.rows[0].id,
          existing_session_id: dup.rows[0].session_id,
        });
      }
    }

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
      await creditWalletIfTopup(r.rows[0].session_id).catch((e) => console.error('[wallet] credit failed (manual resolve):', e.message));
    }
    res.json({ ok: true });
  } catch (e) {
    // Defensive: in case of a race we lost between the duplicate check and the UPDATE.
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'This Transaction ID is already marked Paid on another order.' });
    }
    next(e);
  }
}

module.exports = {
  createSession, getSessionForMerchant,
  getCheckoutSession, listCheckoutGateways, submitTxn, checkoutStatus, cancelCheckout,
  listTransactions, manualResolve,
};
