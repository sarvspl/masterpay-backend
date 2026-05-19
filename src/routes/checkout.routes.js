const express = require('express');
const ctrl = require('../controllers/payment.controller');
const { limiters } = require('../middleware/rateLimit');

const router = express.Router();

// Public — by session id only. No auth.
router.get ('/:id',          ctrl.getCheckoutSession);
router.get ('/:id/gateways', ctrl.listCheckoutGateways);
router.post('/:id/submit',   limiters.checkoutSubmit, ctrl.submitTxn);
router.get ('/:id/status',   ctrl.checkoutStatus);
router.post('/:id/cancel',   ctrl.cancelCheckout);

module.exports = router;
