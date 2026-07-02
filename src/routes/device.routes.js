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
// deviceBruteforce (per-IP, counts only 401=bad-key responses) fronts every
// key-authenticated endpoint so a guessing script is throttled while legit
// phones — which always authenticate — are never affected.
const bf = limiters.deviceBruteforce;
router.post('/bind',         bf, ctrl.bind);
router.post('/unbind',       bf, ctrl.unbind);
router.post('/heartbeat',    bf, guardDevice, ctrl.heartbeat);
router.post('/poll',         bf, guardDevice, ctrl.poll);
router.post('/report',       bf, guardDevice, ctrl.report);
router.post('/sms',          bf, limiters.deviceSms, guardDevice, smsCtrl.upload);
router.post('/transactions', bf, guardDevice, ctrl.listTransactionsForDevice);
router.post('/verify',       bf, guardDevice, ctrl.verifyTxnIdFromDevice);

module.exports = router;
