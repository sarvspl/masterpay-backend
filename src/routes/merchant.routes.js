const express = require('express');
const ctrl = require('../controllers/merchant.controller');
const deviceCtrl = require('../controllers/device.controller');
const gatewayCtrl = require('../controllers/gateway.controller');
const paymentCtrl = require('../controllers/payment.controller');
const smsCtrl = require('../controllers/sms.controller');
const walletCtrl = require('../controllers/wallet.controller');
const ticketsCtrl = require('../controllers/tickets.controller');
const { requireMerchant } = require('../middleware/auth');
const { limiters } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/register', ctrl.register);
router.post('/login', limiters.login, ctrl.login);
router.get('/check-username', ctrl.checkUsername);
router.get('/me', requireMerchant, ctrl.me);
router.patch('/me', requireMerchant, ctrl.updateMe);
router.post('/me/password', requireMerchant, ctrl.changePassword);

router.get   ('/brands',     requireMerchant, ctrl.listBrands);
router.post  ('/brands',     requireMerchant, ctrl.createBrand);
router.delete('/brands/:id', requireMerchant, ctrl.deleteBrand);

router.get   ('/devices',         requireMerchant, deviceCtrl.listForMerchant);
router.get   ('/devices/history', requireMerchant, deviceCtrl.listHistoryForMerchant);
router.delete('/devices/:id',     requireMerchant, deviceCtrl.deleteForMerchant);

router.get   ('/gateways',            requireMerchant, gatewayCtrl.list);
router.post  ('/gateways',            requireMerchant, gatewayCtrl.create);
router.patch ('/gateways/:id',        requireMerchant, gatewayCtrl.update);
router.post  ('/gateways/:id/toggle', requireMerchant, gatewayCtrl.toggle);
router.delete('/gateways/:id',        requireMerchant, gatewayCtrl.remove);

router.get   ('/transactions',                requireMerchant, paymentCtrl.listTransactions);
router.post  ('/transactions/:id/resolve',    requireMerchant, paymentCtrl.manualResolve);

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
