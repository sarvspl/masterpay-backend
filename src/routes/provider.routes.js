const express = require('express');
const ctrl = require('../controllers/provider.controller');

const router = express.Router();

// Public — merchant gateways page reads this to render the catalog.
router.get('/', ctrl.listPublic);

// Public — bank dropdown for UPI (India) gateways.
router.get('/banks', ctrl.listBanksPublic);

module.exports = router;