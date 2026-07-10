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
const { checkWalletSufficient, checkVendorWalletSufficient, isVendorRow } = require('../services/wallet');

// 402 for the APK, which shows the holder exactly how short they are.
function rejectDevice(res, info, isVendor) {
  return res.status(402).json({
    error: 'Wallet empty — top up to resume.',
    merchant_message: isVendor
      ? 'Your wallet has insufficient balance to cover the per-verification fee. Top up in your vendor panel.'
      : 'Merchant wallet has insufficient balance to cover the per-verification fee. Top up at the dashboard.',
    insufficient_balance: true,
    code: isVendor ? 'vendor_wallet_empty' : 'merchant_wallet_empty',
    balance:   info?.balance ?? 0,
    fee:       info?.fee ?? 0,
    threshold: info?.threshold ?? 0,
  });
}

async function guardDevice(req, res, next) {
  try {
    const auth_key = String(req.body && req.body.auth_key || '').trim();
    if (!auth_key) return next(); // let the handler return its own 400/401

    // Resolve the ACCOUNT the phone is bound to, not just its merchant. A
    // vendor's phone must be gated on the VENDOR's wallet — that is the one a
    // verification debits. Gating it on the marketplace's wallet meant a seller
    // with a funded wallet was locked out whenever their marketplace's balance
    // hit zero, with an error they could do nothing about (and the marketplace
    // is never charged for a vendor's payment at all).
    const r = await pool.query(
      `SELECT id, merchant_id, is_default, external_id, username
         FROM accounts WHERE device_auth_key = $1`,
      [auth_key]
    );
    if (r.rowCount === 0) return next(); // handler will return 401
    const acc = r.rows[0];
    const isVendor = isVendorRow(acc);

    const check = isVendor
      ? await checkVendorWalletSufficient(acc.id)
      : await checkWalletSufficient(acc.merchant_id);
    if (!check.ok) return rejectDevice(res, check, isVendor);
    next();
  } catch (e) { next(e); }
}

module.exports = { guardDevice };
