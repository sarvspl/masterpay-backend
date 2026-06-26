/**
 * Vendor panel API — a vendor logging into their own dashboard.
 * Mounted at /api/vendor. Auth = vendor JWT (requireVendor → req.vendor).
 *
 * Most endpoints reuse the merchant-facing controllers, but hard-scoped to the
 * vendor's single account:
 *   - asMerchant      bridges req.vendor.merchant_id onto req.merchant.id so the
 *                     shared controllers (which read req.merchant.id) work.
 *   - scopeAccount*   forces account_id from the token, never from the client,
 *                     so a vendor can't read/aim at another vendor's account.
 *   - ownGateway/ownTxn re-check row ownership before mutating, because the
 *                     shared controllers only scope by merchant_id (which all
 *                     of a marketplace's vendors share).
 */
const express = require('express');
const vendorCtrl = require('../controllers/vendor.controller');
const gatewayCtrl = require('../controllers/gateway.controller');
const paymentCtrl = require('../controllers/payment.controller');
const deviceCtrl = require('../controllers/device.controller');
const { requireVendor, requireActivated } = require('../middleware/auth');
const { limiters } = require('../middleware/rateLimit');
const pool = require('../db/pool');

const router = express.Router();

function asMerchant(req, _res, next) { req.merchant = { id: req.vendor.merchant_id }; next(); }
function scopeAccountQuery(req, _res, next) { req.query.account_id = req.vendor.account_id; next(); }
function scopeAccountBody(req, _res, next) { req.body.account_id = req.vendor.account_id; next(); }

async function ownGateway(req, res, next) {
  try {
    const r = await pool.query('SELECT account_id FROM gateways WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0 || r.rows[0].account_id !== req.vendor.account_id) {
      return res.status(404).json({ error: 'Gateway not found' });
    }
    next();
  } catch (e) { next(e); }
}

async function ownTxn(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT g.account_id
         FROM transactions t JOIN gateways g ON g.id = t.gateway_id
        WHERE t.id = $1`,
      [req.params.id]
    );
    if (r.rowCount === 0 || r.rows[0].account_id !== req.vendor.account_id) {
      return res.status(404).json({ error: 'Transaction not found' });
    }
    next();
  } catch (e) { next(e); }
}

/* ── Auth + profile (always open so the pay screen can render) ── */
router.post('/register',           vendorCtrl.register);
router.post('/login',              limiters.login, vendorCtrl.login);
router.get ('/me',                 requireVendor, vendorCtrl.me);
router.post('/me/password',        requireVendor, vendorCtrl.changePassword);
router.post('/activation/submit',  requireVendor, vendorCtrl.submitActivation);

/* ── Everything below requires an ACTIVATED vendor ── */

/* ── Transactions (with approve/reject) ── */
router.get ('/transactions',             requireVendor, requireActivated, asMerchant, scopeAccountQuery, paymentCtrl.listTransactions);
router.post('/transactions/:id/resolve', requireVendor, requireActivated, asMerchant, ownTxn, paymentCtrl.manualResolve);

/* ── Gateways (full self-service) ── */
router.get   ('/gateways',            requireVendor, requireActivated, asMerchant, scopeAccountQuery, gatewayCtrl.list);
router.post  ('/gateways',            requireVendor, requireActivated, asMerchant, scopeAccountBody, gatewayCtrl.create);
router.patch ('/gateways/:id',        requireVendor, requireActivated, asMerchant, ownGateway, gatewayCtrl.update);
router.post  ('/gateways/:id/toggle', requireVendor, requireActivated, asMerchant, ownGateway, gatewayCtrl.toggle);
router.delete('/gateways/:id',        requireVendor, requireActivated, asMerchant, ownGateway, gatewayCtrl.remove);

/* ── Devices (the phones bound to this vendor) ── */
router.get('/devices', requireVendor, requireActivated, asMerchant, scopeAccountQuery, deviceCtrl.listForMerchant);

/* ── Wallet (balance, ledger, top-up) ── */
router.get ('/wallet',        requireVendor, requireActivated, vendorCtrl.getWallet);
router.post('/wallet/topup',  requireVendor, requireActivated, vendorCtrl.submitTopup);

module.exports = router;
