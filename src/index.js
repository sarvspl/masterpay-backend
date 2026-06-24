require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { startProofCleanupJob, PROOF_DIR } = require('./services/proof');

const merchantRoutes = require('./routes/merchant.routes');
const adminRoutes = require('./routes/admin.routes');
const deviceRoutes = require('./routes/device.routes');
const paymentRoutes = require('./routes/payment.routes');
const checkoutRoutes = require('./routes/checkout.routes');
const vendorRoutes = require('./routes/vendors.routes');
const vendorPanelRoutes = require('./routes/vendor-panel.routes');
const providerRoutes = require('./routes/provider.routes');
const supportCtrl    = require('./controllers/support.controller');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();

app.use(cors());

// Body parsing: keep the global limit tight at 1 MB, but allow the checkout
// submit endpoint up to 8 MB so it can carry a base64 payment screenshot.
// (The client downscales screenshots first, so real payloads are ~200 KB.)
const stdJson = express.json({ limit: '1mb' });
const bigJson = express.json({ limit: '8mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && /^\/api\/checkout\/[^/]+\/submit$/.test(req.path)) {
    return bigJson(req, res, next);
  }
  return stdJson(req, res, next);
});

// Serve uploaded payment-proof screenshots. Filenames are random UUIDs, so the
// URLs are unguessable; they're auto-purged after 30 days.
app.use('/uploads/proofs', express.static(PROOF_DIR, { fallthrough: false, maxAge: '7d' }));

app.get('/health', (req, res) => res.json({ ok: true, service: 'payverify-backend' }));

app.use('/api/merchant', merchantRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/device', deviceRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/vendor', vendorPanelRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/providers', providerRoutes);

app.get('/api/support', supportCtrl.getPublic);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`PayVerify backend listening on http://localhost:${PORT}`);
  startProofCleanupJob(); // purge payment screenshots older than 30 days
});
