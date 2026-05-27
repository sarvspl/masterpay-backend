/**
 * Wallet balance guard. Returns 402 + insufficient_balance:true when the
 * acting merchant doesn't have enough wallet balance to cover the
 * per-verification fee configured by the platform admin.
 *
 * Two variants — they return different SHAPES because the audience differs:
 *
 *   - guardMerchant — for the X-API-Key endpoints xyz.com calls. The error
 *     eventually reaches the customer's browser, so we return a customer-safe
 *     shape with NO numeric leaks (no balance, no fee, no threshold).
 *
 *   - guardDevice — for the APK on the merchant's own phone. The merchant
 *     legitimately needs to see exactly how short they are, so the detailed
 *     payload is fine here.
 */
const pool = require('../db/pool');
const { checkWalletSufficient } = require('../services/wallet');

// Customer-safe 402 — the merchant's integration sometimes leaks our error
// payload straight to the customer, so the `error` text must be neutral and
// the technical detail must live on a separate field the integrator can read.
function rejectCustomerSafe(res) {
  return res.status(402).json({
    error: 'Services currently unavailable.',
    merchant_message:
      'Merchant wallet has insufficient balance to cover the per-verification fee. Top up at the dashboard.',
    insufficient_balance: true,
    code: 'merchant_wallet_empty',
  });
}

// Merchant-facing 402 — surfaced to APK / dashboard, so balance / fee /
// threshold are appropriate context.
function rejectMerchantFacing(res, info) {
  return res.status(402).json({
    error: 'Wallet empty — top up to resume.',
    merchant_message:
      'Merchant wallet has insufficient balance to cover the per-verification fee. Top up at the dashboard.',
    insufficient_balance: true,
    code: 'merchant_wallet_empty',
    balance:   info?.balance ?? 0,
    fee:       info?.fee ?? 0,
    threshold: info?.threshold ?? 0,
  });
}

async function guardMerchant(req, res, next) {
  try {
    const merchantId = req.brand && req.brand.merchant_id;
    if (!merchantId) return next();
    const check = await checkWalletSufficient(merchantId);
    if (!check.ok) return rejectCustomerSafe(res);
    next();
  } catch (e) { next(e); }
}

async function guardDevice(req, res, next) {
  try {
    const auth_key = String(req.body && req.body.auth_key || '').trim();
    if (!auth_key) return next(); // let the handler return its own 400/401

    const r = await pool.query(
      `SELECT m.id FROM merchants m
         JOIN accounts a ON a.merchant_id = m.id
        WHERE a.device_auth_key = $1`,
      [auth_key]
    );
    if (r.rowCount === 0) return next(); // handler will return 401

    const check = await checkWalletSufficient(r.rows[0].id);
    if (!check.ok) return rejectMerchantFacing(res, check);
    next();
  } catch (e) { next(e); }
}

module.exports = { guardMerchant, guardDevice };
