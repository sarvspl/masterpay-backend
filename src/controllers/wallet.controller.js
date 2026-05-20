/**
 * Merchant-facing wallet endpoints. The recharge flow creates a payment
 * session against the platform merchant (with metadata that the credit hook
 * recognises), so all the existing checkout + verification machinery handles
 * verification. On success the credit hook adds to wallet_balance.
 */
const pool = require('../db/pool');
const { generateSessionId } = require('../utils/session');
const { getPlatformMerchantId } = require('./platform.controller');
const { getPlatformSettings, computeTopupFee } = require('../services/wallet');

const TOPUP_MIN = 10;
const TOPUP_MAX = 100_000;
const SESSION_TTL_MIN = 24 * 60; // 24 hours (matches checkout session lifetime)

/* ── GET /api/merchant/wallet — balance + recent ledger entries ── */
async function getWallet(req, res, next) {
  try {
    const balanceR = await pool.query(
      `SELECT wallet_balance, currency FROM merchants WHERE id = $1`,
      [req.merchant.id]
    );
    if (balanceR.rowCount === 0) return res.status(404).json({ error: 'Merchant not found' });

    const ledgerR = await pool.query(
      `SELECT id, amount, kind, source_session_id, source_transaction_id, note, created_at
         FROM wallet_ledger
        WHERE merchant_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.merchant.id]
    );

    // Expose the top-up fee rate so the dashboard can show a live "you pay"
    // breakdown before the merchant commits to a recharge.
    const settings = await getPlatformSettings().catch(() => null);

    res.json({
      balance:  Number(balanceR.rows[0].wallet_balance),
      currency: balanceR.rows[0].currency,
      ledger:   ledgerR.rows,
      topup_fee_enabled: !!(settings && settings.topup_fee_enabled),
      topup_fee_percent: Number(settings && settings.topup_fee_percent || 0),
    });
  } catch (e) { next(e); }
}

/* ── GET /api/merchant/wallet/recharges — recent recharge sessions ── */
async function listRecharges(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT s.id AS session_id, s.amount, s.currency, s.status AS session_status,
              s.created_at, s.expires_at,
              t.id AS transaction_id, t.txnid_submitted, t.status AS tx_status,
              t.result_source, t.verified_at, t.failure_reason,
              g.provider, g.variant, g.account_number, g.label AS gateway_label
         FROM payment_sessions s
         LEFT JOIN LATERAL (
           SELECT id, txnid_submitted, status, result_source, verified_at, failure_reason, gateway_id
             FROM transactions
            WHERE session_id = s.id
            ORDER BY created_at DESC LIMIT 1
         ) t ON TRUE
         LEFT JOIN gateways g ON g.id = t.gateway_id
        WHERE s.metadata->>'type' = 'wallet_topup'
          AND s.metadata->>'recharge_for_merchant_id' = $1::text
        ORDER BY s.created_at DESC
        LIMIT 50`,
      [String(req.merchant.id)]
    );
    res.json({ recharges: r.rows });
  } catch (e) { next(e); }
}

/* ── POST /api/merchant/wallet/recharge — start a topup ───
 *  body: { amount }
 *  Creates a payment session against the platform merchant + returns
 *  a checkout_url the merchant should redirect to.
 */
async function startRecharge(req, res, next) {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount is required and must be positive.' });
    }
    if (amount < TOPUP_MIN || amount > TOPUP_MAX) {
      return res.status(400).json({ error: `Amount must be between ${TOPUP_MIN} and ${TOPUP_MAX}.` });
    }

    // Need the platform merchant + its default brand.
    const platformId = await getPlatformMerchantId();
    const brandR = await pool.query(
      `SELECT b.id AS brand_id, m.currency
         FROM brands b
         JOIN merchants m ON m.id = b.merchant_id
        WHERE b.merchant_id = $1 AND b.is_default = TRUE
        LIMIT 1`,
      [platformId]
    );
    if (brandR.rowCount === 0) {
      return res.status(503).json({ error: 'Wallet recharge is not configured yet. Contact support.' });
    }

    // No gateways? No point starting a checkout — the customer would get stuck.
    const gwR = await pool.query(
      `SELECT 1 FROM gateways WHERE merchant_id = $1 AND is_enabled = TRUE LIMIT 1`,
      [platformId]
    );
    if (gwR.rowCount === 0) {
      return res.status(503).json({ error: 'Wallet recharge is temporarily unavailable. Contact support.' });
    }

    // The recharger's own currency. The session is on platform merchant but
    // we keep the rechargee's currency so amounts stay consistent on their side.
    const meR = await pool.query(`SELECT currency, name FROM merchants WHERE id = $1`, [req.merchant.id]);
    const currency = meR.rows[0]?.currency || 'BDT';
    const merchantName = meR.rows[0]?.name || 'Merchant';

    // `amount` is what the merchant wants CREDITED. The top-up fee is added on
    // top, so the gross they actually pay (and what the gateway SMS will show)
    // is credit + fee. We credit the net on success; the fee is platform income.
    const settings = await getPlatformSettings().catch(() => null);
    const fee   = settings ? computeTopupFee(settings, amount) : 0;
    const gross = Math.round((amount + fee) * 100) / 100;

    const id = generateSessionId();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MIN * 60 * 1000);
    const orderId = 'WALLET-' + req.merchant.id + '-' + Date.now().toString(36).toUpperCase();
    const baseUrl = process.env.PUBLIC_CHECKOUT_BASE_URL || 'http://localhost:3000';

    await pool.query(
      `INSERT INTO payment_sessions
         (id, merchant_id, brand_id, order_id, amount, currency,
          customer_phone, customer_name, redirect_url, metadata, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, platformId, brandR.rows[0].brand_id, orderId, gross, currency,
        null, merchantName,
        `${baseUrl}/dashboard/wallet?topup=ok`,
        {
          type: 'wallet_topup',
          recharge_for_merchant_id: req.merchant.id,
          topup_credit_amount: amount,
          topup_fee: fee,
          topup_fee_percent: settings ? Number(settings.topup_fee_percent || 0) : 0,
        },
        expiresAt,
      ]
    );

    res.status(201).json({
      session_id:   id,
      checkout_url: `${baseUrl}/pay/${id}`,
      expires_at:   expiresAt.toISOString(),
      amount,        // credited
      fee,           // added on top
      total: gross,  // what they pay
      currency,
    });
  } catch (e) { next(e); }
}

module.exports = { getWallet, listRecharges, startRecharge };
