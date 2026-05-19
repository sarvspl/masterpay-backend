const express = require('express');
const ctrl = require('../controllers/device.controller');
const smsCtrl = require('../controllers/sms.controller');
const { guardDevice } = require('../middleware/walletGuard');
const { limiters } = require('../middleware/rateLimit');

const router = express.Router();

// APK-facing — secured by the merchant's device_auth_key, no JWT
//
// bind / unbind run WITHOUT the wallet guard so a merchant can still connect
// or disconnect their phone even if they're broke. Every other operation
// (heartbeat / poll / sms / report / verify / transactions) requires the
// merchant to have at least the per-verification fee in their wallet.
router.post('/bind',         ctrl.bind);
router.post('/unbind',       ctrl.unbind);
router.post('/heartbeat',    guardDevice, ctrl.heartbeat);
router.post('/poll',         guardDevice, ctrl.poll);
router.post('/report',       guardDevice, ctrl.report);
router.post('/sms',          limiters.deviceSms, guardDevice, smsCtrl.upload);
router.post('/transactions', guardDevice, ctrl.listTransactionsForDevice);
router.post('/verify',       guardDevice, ctrl.verifyTxnIdFromDevice);

module.exports = router;
