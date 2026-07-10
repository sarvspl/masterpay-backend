const express = require('express');
const ctrl = require('../controllers/payment.controller');
const { requireApiKey } = require('../middleware/apiKey');
const { limiters } = require('../middleware/rateLimit');

const router = express.Router();

// Merchant-server-facing — auth via X-API-Key (brand's pk_live_...)
//
// Session CREATION is still wallet-gated, but the gate now lives INSIDE
// createSession, as one of the conditions of `payable` (services/availability →
// reason `vendor_wallet_empty`). It used to be the guardMerchant middleware,
// which short-circuited with a generic 402 *before* the controller ran — so a
// vendor who was unavailable for some other reason (never registered, no
// payment number) got a misleading "Merchant wallet has insufficient balance"
// instead of the real explanation. Every "this vendor can't take the payment"
// answer is now a single 422 carrying the precise `reason` + `display`.
//
// Status reads stay open (so xyz.com can still poll existing sessions).
router.post('/sessions',     limiters.paymentSessionCreate, requireApiKey, ctrl.createSession);
router.get ('/sessions/:id', requireApiKey, ctrl.getSessionForMerchant);

module.exports = router;
