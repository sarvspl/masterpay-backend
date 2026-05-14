require('dotenv').config();
const express = require('express');
const cors = require('cors');

const merchantRoutes = require('./routes/merchant.routes');
const adminRoutes = require('./routes/admin.routes');
const deviceRoutes = require('./routes/device.routes');
const paymentRoutes = require('./routes/payment.routes');
const checkoutRoutes = require('./routes/checkout.routes');
const providerRoutes = require('./routes/provider.routes');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ ok: true, service: 'payverify-backend' }));

app.use('/api/merchant', merchantRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/device', deviceRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/providers', providerRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`PayVerify backend listening on http://localhost:${PORT}`);
});
