const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const provCtrl = require('../controllers/provider.controller');

router.post('/login', ctrl.login);
router.get('/merchants', requireAdmin, ctrl.listMerchants);
router.get('/merchants/:id', requireAdmin, ctrl.getMerchant);
router.post('/merchants', requireAdmin, ctrl.createMerchant);
router.post('/merchants/:id/suspend',   requireAdmin, ctrl.suspendMerchant);
router.post('/merchants/:id/unsuspend', requireAdmin, ctrl.unsuspendMerchant);

router.get   ('/providers',     requireAdmin, provCtrl.adminList);
router.post  ('/providers',     requireAdmin, provCtrl.adminCreate);
router.patch ('/providers/:id', requireAdmin, provCtrl.adminUpdate);
router.delete('/providers/:id', requireAdmin, provCtrl.adminDelete);

module.exports = router;
