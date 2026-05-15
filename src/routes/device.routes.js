const express = require('express');
const ctrl = require('../controllers/device.controller');
const smsCtrl = require('../controllers/sms.controller');

const router = express.Router();

// APK-facing — secured by the merchant's device_auth_key, no JWT
router.post('/bind',         ctrl.bind);
router.post('/unbind',       ctrl.unbind);
router.post('/heartbeat',    ctrl.heartbeat);
router.post('/poll',         ctrl.poll);
router.post('/report',       ctrl.report);
router.post('/sms',          smsCtrl.upload);
router.post('/transactions', ctrl.listTransactionsForDevice);
router.post('/verify',       ctrl.verifyTxnIdFromDevice);

module.exports = router;
