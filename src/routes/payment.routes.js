const express = require('express');
const ctrl = require('../controllers/payment.controller');
const { requireApiKey } = require('../middleware/apiKey');

const router = express.Router();

// Merchant-server-facing — auth via X-API-Key (brand's pk_live_...)
router.post('/sessions',     requireApiKey, ctrl.createSession);
router.get ('/sessions/:id', requireApiKey, ctrl.getSessionForMerchant);

module.exports = router;
