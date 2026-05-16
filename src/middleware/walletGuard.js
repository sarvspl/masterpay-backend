/**
 * Wallet balance guard. Returns 402 + insufficient_balance:true when the
 * acting merchant doesn't have enough wallet balance to cover the
 * per-verification fee configured by the platform admin.
 *
 * Two variants:
 *   - guardMerchant   — for API-key-authed endpoints (req.brand.merchant_id set
 *                        by requireApiKey middleware). Used on payment session
 *                        creation, so xyz.com can't take new payments through
 *                        a merchant with an empty wallet.
 *   - guardDevice     — for APK endpoints. Resolves merchant_id from the
 *                        auth_key in the request body, then runs the same check.
 *                        Used on poll/sms/report/verify/heartbeat — but NOT
 *                        bind/unbind (so a user can still connect/disconnect).
 */
const pool = require('../db/pool');
const { checkWalletSufficient } = require('../services/wallet');

function reject(res, info) {
  return res.status(402).json({
    error: 'Merchant wallet has insufficient balance. Top up to resume.',
    insufficient_balance: true,
    balance: info?.balance ?? 0,
    fee: info?.fee ?? 0,
    threshold: info?.threshold ?? 0,
  });
}

async function guardMerchant(req, res, next) {
  try {
    const merchantId = req.brand && req.brand.merchant_id;
    if (!merchantId) return next();
    const check = await checkWalletSufficient(merchantId);
    if (!check.ok) return reject(res, check);
    next();
  } catch (e) { next(e); }
}

async function guardDevice(req, res, next) {
  try {
    const auth_key = String(req.body && req.body.auth_key || '').trim();
    if (!auth_key) return next(); // let the handler return its own 400/401

    const r = await pool.query(
      `SELECT m.id FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
        WHERE k.device_auth_key = $1`,
      [auth_key]
    );
    if (r.rowCount === 0) return next(); // handler will return 401

    const check = await checkWalletSufficient(r.rows[0].id);
    if (!check.ok) return reject(res, check);
    next();
  } catch (e) { next(e); }
}

module.exports = { guardMerchant, guardDevice };
