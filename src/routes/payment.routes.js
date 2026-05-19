const express = require('express');
const ctrl = require('../controllers/payment.controller');
const { requireApiKey } = require('../middleware/apiKey');
const { guardMerchant } = require('../middleware/walletGuard');
const { limiters } = require('../middleware/rateLimit');

const router = express.Router();

// Merchant-server-facing — auth via X-API-Key (brand's pk_live_...)
// Session CREATION is wallet-gated: a merchant with insufficient balance
// can't take new payments because we couldn't verify them anyway.
// Status reads stay open (so xyz.com can still poll existing sessions).
router.post('/sessions',     limiters.paymentSessionCreate, requireApiKey, guardMerchant, ctrl.createSession);
router.get ('/sessions/:id', requireApiKey, ctrl.getSessionForMerchant);

module.exports = router;
