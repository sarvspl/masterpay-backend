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

router.post('/', requireApiKey, ctrl.create);
router.get ('/', requireApiKey, ctrl.list);

// MUST precede '/:id' — otherwise Express matches these as a vendor id.
router.get('/availability', requireApiKey, ctrl.availability);
router.get('/device-key',   requireApiKey, ctrl.deviceKey);

router.get('/:id', requireApiKey, ctrl.get);

// A marketplace can suspend/reinstate its own seller. Unsuspend only lifts a
// suspension the MERCHANT applied — a platform (superadmin) suspension 403s.
router.post('/:id/suspend',   requireApiKey, ctrl.suspend);
router.post('/:id/unsuspend', requireApiKey, ctrl.unsuspend);

// Vendor payment numbers are READ-ONLY to the marketplace. A vendor's bKash /
// Nagad numbers belong to the vendor and are managed only in their own panel
// (/api/vendor/gateways). The marketplace operator can see them, so they can
// support a seller, but can never add, edit, pause, or delete one — otherwise a
// marketplace could redirect a seller's money to itself.
router.get('/:id/gateways', requireApiKey, asMerchant, (req, res, next) => {
  req.query.account_id = req.params.id;
  return gatewayCtrl.list(req, res, next);
});

const VENDOR_OWNED = {
  error: 'A vendor’s payment numbers are managed by the vendor in their own panel.',
  code: 'vendor_managed',
};
router.post  ('/:id/gateways',           requireApiKey, (_req, res) => res.status(403).json(VENDOR_OWNED));
router.patch ('/:vendorId/gateways/:id', requireApiKey, (_req, res) => res.status(403).json(VENDOR_OWNED));
router.delete('/:vendorId/gateways/:id', requireApiKey, (_req, res) => res.status(403).json(VENDOR_OWNED));

module.exports = router;
