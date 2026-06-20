const express = require('express');
const ctrl = require('../controllers/vendors.controller');
const gatewayCtrl = require('../controllers/gateway.controller');
const { requireApiKey } = require('../middleware/apiKey');

const router = express.Router();

// Vendor endpoints authenticate with the merchant API key (X-API-Key → req.brand).
// The gateway controller is shared with the dashboard and reads req.merchant.id,
// so bridge the brand's merchant onto req.merchant for the gateway sub-routes.
function asMerchant(req, _res, next) {
  req.merchant = { id: req.brand.merchant_id };
  next();
}

router.post('/',    requireApiKey, ctrl.create);
router.get ('/',    requireApiKey, ctrl.list);
router.get ('/:id', requireApiKey, ctrl.get);

// Vendor payment numbers — reuse the gateway controller, scoped to the vendor's
// account. account_id is forced from the URL so a caller can't target another
// vendor; ownership is still re-checked inside the controller against the merchant.
router.get('/:id/gateways', requireApiKey, asMerchant, (req, res, next) => {
  req.query.account_id = req.params.id;
  return gatewayCtrl.list(req, res, next);
});
router.post('/:id/gateways', requireApiKey, asMerchant, (req, res, next) => {
  req.body.account_id = req.params.id;
  return gatewayCtrl.create(req, res, next);
});
router.patch('/:vendorId/gateways/:id', requireApiKey, asMerchant, gatewayCtrl.update);
router.delete('/:vendorId/gateways/:id', requireApiKey, asMerchant, gatewayCtrl.remove);

module.exports = router;
