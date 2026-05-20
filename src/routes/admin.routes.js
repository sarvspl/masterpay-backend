const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const provCtrl     = require('../controllers/provider.controller');
const supportCtrl  = require('../controllers/support.controller');
const platformCtrl = require('../controllers/platform.controller');
const ticketsCtrl  = require('../controllers/tickets.controller');
const { limiters } = require('../middleware/rateLimit');

router.post('/login', limiters.login, ctrl.login);
router.get('/merchants', requireAdmin, ctrl.listMerchants);
router.get('/merchants/:id', requireAdmin, ctrl.getMerchant);
router.post('/merchants', requireAdmin, ctrl.createMerchant);
router.post('/merchants/:id/suspend',        requireAdmin, ctrl.suspendMerchant);
router.post('/merchants/:id/unsuspend',      requireAdmin, ctrl.unsuspendMerchant);
router.post('/merchants/:id/wallet',         requireAdmin, ctrl.adjustWallet);
router.get ('/merchants/:id/wallet/ledger',  requireAdmin, ctrl.getMerchantLedger);
router.get ('/merchants/:id/wallet/recharges', requireAdmin, ctrl.getMerchantRecharges);
router.post('/merchants/:id/reset-password', requireAdmin, ctrl.resetMerchantPassword);

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
router.get('/platform/transactions',          requireAdmin, platformCtrl.listTransactions);
router.post('/platform/transactions/:id/resolve', requireAdmin, platformCtrl.manualResolveTransaction);

router.get  ('/tickets',                  requireAdmin, ticketsCtrl.adminList);
router.get  ('/tickets/:id',              requireAdmin, ticketsCtrl.adminGet);
router.post ('/tickets/:id/messages',     requireAdmin, ticketsCtrl.adminReply);
router.patch('/tickets/:id',              requireAdmin, ticketsCtrl.adminUpdate);

module.exports = router;
