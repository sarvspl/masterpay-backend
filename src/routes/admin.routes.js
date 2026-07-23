const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const provCtrl     = require('../controllers/provider.controller');
const supportCtrl  = require('../controllers/support.controller');
const platformCtrl = require('../controllers/platform.controller');
const ticketsCtrl  = require('../controllers/tickets.controller');
const vendorsCtrl  = require('../controllers/adminVendors.controller');
const withdrawalsCtrl = require('../controllers/withdrawals.controller');
const financeCtrl = require('../controllers/finance.controller');
const { limiters } = require('../middleware/rateLimit');

router.post('/login', limiters.login, ctrl.login);
router.post('/logout', ctrl.logout);
// Throttled per-admin (NOT with `limiters.login`, which is IP-keyed and shared
// with every login route — fumbling this twice must not lock you out of signing
// in). requireAdmin runs first so the limiter can key on the account.
router.post('/me/password', requireAdmin, limiters.passwordChange, ctrl.changeOwnPassword);
router.get('/merchants', requireAdmin, ctrl.listMerchants);
router.get('/merchants/:id', requireAdmin, ctrl.getMerchant);
router.post('/merchants', requireAdmin, ctrl.createMerchant);
router.post('/merchants/:id/suspend',        requireAdmin, ctrl.suspendMerchant);
router.post('/merchants/:id/unsuspend',      requireAdmin, ctrl.unsuspendMerchant);
router.post('/merchants/:id/wallet',         requireAdmin, ctrl.adjustWallet);
router.get ('/merchants/:id/wallet/ledger',  requireAdmin, ctrl.getMerchantLedger);
router.get ('/merchants/:id/wallet/recharges', requireAdmin, ctrl.getMerchantRecharges);
router.post('/merchants/:id/reset-password', requireAdmin, ctrl.resetMerchantPassword);

// Vendors — the admin is the only role that can see a seller's full record
// (device key, wallet, transactions) and the only one who can top up their
// wallet or reset their password. The marketplace operator can do neither.
// '/vendors' MUST precede '/vendors/:id' or Express treats the list as an id.
// The wallet route is a top-up: credit only, never a debit.
router.get ('/vendors',                    requireAdmin, vendorsCtrl.listVendors);
router.get ('/vendors/:id',                requireAdmin, vendorsCtrl.getVendor);
router.post('/vendors/:id/onboard',        requireAdmin, vendorsCtrl.onboardVendor);
router.post('/vendors/:id/wallet',         requireAdmin, vendorsCtrl.creditVendorWallet);
router.post('/vendors/:id/reset-password', requireAdmin, vendorsCtrl.resetVendorPassword);
router.post('/vendors/:id/regenerate-key', requireAdmin, vendorsCtrl.regenerateVendorDeviceKey);
router.post('/vendors/:id/suspend',        requireAdmin, vendorsCtrl.suspendVendorAdmin);
router.post('/vendors/:id/unsuspend',      requireAdmin, vendorsCtrl.unsuspendVendorAdmin);

// The whole business in one call: revenue booked, cash actually received, and
// the float owed back to merchants and vendors.
router.get('/finance', requireAdmin, financeCtrl.getFinance);

// Merchant wallet withdrawals. Approving records an off-platform payout;
// rejecting refunds the amount that was held when the request was filed.
router.get ('/withdrawals',             requireAdmin, withdrawalsCtrl.listForAdmin);
router.post('/withdrawals/:id/approve', requireAdmin, withdrawalsCtrl.approve);
router.post('/withdrawals/:id/reject',  requireAdmin, withdrawalsCtrl.reject);

router.patch('/devices/:id', requireAdmin, ctrl.updateDevice);

router.get   ('/providers',     requireAdmin, provCtrl.adminList);
router.post  ('/providers',     requireAdmin, provCtrl.adminCreate);
router.patch ('/providers/:id', requireAdmin, provCtrl.adminUpdate);
router.delete('/providers/:id', requireAdmin, provCtrl.adminDelete);

router.get('/support',   requireAdmin, supportCtrl.getForAdmin);
router.put('/support',   requireAdmin, supportCtrl.updateForAdmin);

/* Platform merchant — receives wallet topups from real merchants */
router.get('/platform',                       requireAdmin, platformCtrl.getInfo);
router.get('/platform/settings',              requireAdmin, platformCtrl.getSettings);
router.put('/platform/settings',              requireAdmin, platformCtrl.updateSettings);
router.get('/platform/recharges',             requireAdmin, platformCtrl.listRecharges);
router.get('/platform/revenue',               requireAdmin, platformCtrl.getRevenue);
router.get('/platform/gateways',              requireAdmin, platformCtrl.listGateways);
router.post('/platform/gateways',             requireAdmin, platformCtrl.createGateway);
router.patch('/platform/gateways/:id',        requireAdmin, platformCtrl.updateGateway);
router.post('/platform/gateways/:id/toggle',  requireAdmin, platformCtrl.toggleGateway);
router.delete('/platform/gateways/:id',       requireAdmin, platformCtrl.removeGateway);
router.get('/platform/devices',               requireAdmin, platformCtrl.listDevices);
router.get('/platform/devices/history',       requireAdmin, platformCtrl.listDeviceHistory);
router.delete('/platform/devices/:id',        requireAdmin, platformCtrl.removeDevice);
// Hard delete of an already-unbound row. Separate path so an unbind can never
// be mistaken for a purge, and vice versa.
router.delete('/platform/devices/:id/purge',  requireAdmin, platformCtrl.purgeDevice);
router.get('/platform/transactions',          requireAdmin, platformCtrl.listTransactions);
router.post('/platform/transactions/:id/resolve', requireAdmin, platformCtrl.manualResolveTransaction);

router.get  ('/tickets',                  requireAdmin, ticketsCtrl.adminList);
router.get  ('/tickets/:id',              requireAdmin, ticketsCtrl.adminGet);
router.post ('/tickets/:id/messages',     requireAdmin, ticketsCtrl.adminReply);
router.patch('/tickets/:id',              requireAdmin, ticketsCtrl.adminUpdate);

module.exports = router;
