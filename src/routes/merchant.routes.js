const express = require('express');
const ctrl = require('../controllers/merchant.controller');
const accountsCtrl = require('../controllers/accounts.controller');
const deviceCtrl = require('../controllers/device.controller');
const gatewayCtrl = require('../controllers/gateway.controller');
const paymentCtrl = require('../controllers/payment.controller');
const smsCtrl = require('../controllers/sms.controller');
const walletCtrl = require('../controllers/wallet.controller');
const ticketsCtrl = require('../controllers/tickets.controller');
const { requireMerchant } = require('../middleware/auth');
const { limiters } = require('../middleware/rateLimit');
const { isVendorAccount } = require('../services/vendors');
const pool = require('../db/pool');

const router = express.Router();

router.post('/register', ctrl.register);
router.post('/login', limiters.login, ctrl.login);
router.post('/logout', ctrl.logout);
router.get('/check-username', ctrl.checkUsername);
router.get('/me', requireMerchant, ctrl.me);
router.post('/keys/unlock', requireMerchant, ctrl.unlockKeys);
router.patch('/me', requireMerchant, ctrl.updateMe);
router.post('/me/password', requireMerchant, ctrl.changePassword);

router.get   ('/brands',     requireMerchant, ctrl.listBrands);
router.post  ('/brands',     requireMerchant, ctrl.createBrand);
router.delete('/brands/:id', requireMerchant, ctrl.deleteBrand);

// Vendors: the operator may ADD and VIEW. Nothing else.
//
// Once a vendor exists it belongs to the seller — the operator cannot edit,
// pause, unlock, regenerate its device key, or delete it. Those routes stay
// mounted (rather than deleted) so a stale client gets a clear 403 instead of a
// confusing 404, and `guardNotVendor` lets the operator still manage their own
// Primary account, which is not a vendor.
router.get ('/accounts', requireMerchant, accountsCtrl.list);
router.post('/accounts', requireMerchant, accountsCtrl.create);

router.post  ('/accounts/:id/unlock',         requireMerchant, accountsCtrl.guardNotVendor, accountsCtrl.unlock);
router.post  ('/accounts/:id/regenerate-key', requireMerchant, accountsCtrl.guardNotVendor, accountsCtrl.regenerateDeviceKey);
router.delete('/accounts/:id',                requireMerchant, accountsCtrl.guardNotVendor, accountsCtrl.remove);

// A marketplace binds no phone of its own. Every device belongs to a vendor,
// who manages it from their own panel (/api/vendor/devices). The operator could
// previously list them — exposing each seller's binder name, Telegram handle and
// WhatsApp number — and even PATCH or DELETE them, disconnecting a seller's phone.
// Routes stay mounted so a stale client gets a clear 403 rather than a 404.
const DEVICES_VENDOR_MANAGED = {
  error: 'Phones belong to vendors and are managed by them in their own panel.',
  code: 'vendor_managed',
};
router.get   ('/devices',         requireMerchant, (_req, res) => res.status(403).json(DEVICES_VENDOR_MANAGED));
router.get   ('/devices/history', requireMerchant, (_req, res) => res.status(403).json(DEVICES_VENDOR_MANAGED));
router.patch ('/devices/:id',     requireMerchant, (_req, res) => res.status(403).json(DEVICES_VENDOR_MANAGED));
router.delete('/devices/:id',     requireMerchant, (_req, res) => res.status(403).json(DEVICES_VENDOR_MANAGED));

// A merchant is a marketplace — it owns NO payment numbers. Every gateway in
// the system belongs to a vendor and is managed only by that vendor, in their
// own panel (/api/vendor/gateways). The merchant keeps read-only visibility so
// their dashboard can show which vendors are set up to take money.
//
// (The platform's own receiving numbers are a separate surface, managed by the
// super-admin at /api/admin/platform/gateways.)
router.get('/gateways', requireMerchant, gatewayCtrl.list);

const VENDOR_MANAGED = {
  error: 'Payment numbers belong to vendors and are managed by them in their own panel.',
  code: 'vendor_managed',
};
router.post  ('/gateways',            requireMerchant, (_req, res) => res.status(403).json(VENDOR_MANAGED));
router.patch ('/gateways/:id',        requireMerchant, (_req, res) => res.status(403).json(VENDOR_MANAGED));
router.post  ('/gateways/:id/toggle', requireMerchant, (_req, res) => res.status(403).json(VENDOR_MANAGED));
router.delete('/gateways/:id',        requireMerchant, (_req, res) => res.status(403).json(VENDOR_MANAGED));

// A vendor's payments are the vendor's business. The operator neither sees them
// nor resolves them — approving/rejecting a customer's payment is the seller's
// call, made from their own panel (or their phone).
function hideVendorTxns(req, _res, next) { req.hideVendorTxns = true; next(); }

async function guardTxnNotVendor(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT g.account_id FROM transactions t
         JOIN gateways g ON g.id = t.gateway_id
        WHERE t.id = $1 AND t.merchant_id = $2`,
      [req.params.id, req.merchant.id]
    );
    // 404, not 403: the operator can't see this transaction, so it must not
    // exist as far as they're concerned.
    if (r.rowCount === 0) return res.status(404).json({ error: 'Transaction not found' });
    if (await isVendorAccount(r.rows[0].account_id)) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    next();
  } catch (e) { next(e); }
}

router.get   ('/transactions',             requireMerchant, hideVendorTxns, paymentCtrl.listTransactions);
router.post  ('/transactions/:id/resolve', requireMerchant, guardTxnNotVendor, paymentCtrl.manualResolve);

router.get   ('/sms',        requireMerchant, smsCtrl.listForMerchant);
router.post  ('/verify',     limiters.merchantVerify, requireMerchant, smsCtrl.verifyTxnIdManually);

router.get   ('/wallet',            requireMerchant, walletCtrl.getWallet);
router.get   ('/wallet/recharges',  requireMerchant, walletCtrl.listRecharges);
router.post  ('/wallet/recharge',   requireMerchant, walletCtrl.startRecharge);

router.get   ('/tickets',                  requireMerchant, ticketsCtrl.merchantList);
router.post  ('/tickets',                  requireMerchant, ticketsCtrl.merchantCreate);
router.get   ('/tickets/:id',              requireMerchant, ticketsCtrl.merchantGet);
router.post  ('/tickets/:id/messages',     requireMerchant, ticketsCtrl.merchantReply);

module.exports = router;
