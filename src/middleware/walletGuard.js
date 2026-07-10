/**
 * Wallet balance guard for the APK on a merchant's own phone. Returns 402 +
 * insufficient_balance:true when the acting merchant doesn't have enough wallet
 * balance to cover the per-verification fee configured by the platform admin.
 * The merchant legitimately needs to see exactly how short they are, so the
 * detailed payload (balance / fee / threshold) is fine here.
 *
 * There used to be a sibling `guardMerchant` on POST /api/payment/sessions. It
 * was removed: it ran BEFORE the controller and short-circuited with a generic
 * "Merchant wallet has insufficient balance" 402 whenever the *vendor's* wallet
 * was short — which both named the wrong wallet and masked the real reason when
 * the vendor was unavailable for some other cause. That check now lives in
 * services/availability.js as the `vendor_wallet_empty` reason, so createSession
 * answers every "this vendor can't take the payment" case with one 422.
 */
const pool = require('../db/pool');
const { checkWalletSufficient } = require('../services/wallet');

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

module.exports = { guardDevice };
