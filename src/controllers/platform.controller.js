/**
 * Admin-facing endpoints for managing the singleton "platform merchant" —
 * the merchant row that receives wallet topups from real merchants.
 *
 * These endpoints proxy through to the existing merchant-facing controllers
 * by injecting `req.merchant = { id: <platform_merchant_id> }` before
 * delegating. That way the platform merchant uses the exact same gateway /
 * device / transaction machinery a normal merchant uses — no fork.
 */
const pool = require('../db/pool');

const gatewayCtrl  = require('./gateway.controller');
const deviceCtrl   = require('./device.controller');
const paymentCtrl  = require('./payment.controller');

let cachedId = null;

async function getPlatformMerchantId() {
  if (cachedId) return cachedId;
  const r = await pool.query(`SELECT id FROM merchants WHERE is_platform = TRUE LIMIT 1`);
  if (r.rowCount === 0) {
    throw new Error('Platform merchant not seeded — run migrations.');
  }
  cachedId = r.rows[0].id;
  return cachedId;
}

/* Middleware-style wrapper: load platform merchant id into req.merchant, then
 * delegate to a regular merchant-facing handler. */
function asPlatformMerchant(handler) {
  return async function (req, res, next) {
    try {
      const id = await getPlatformMerchantId();
      req.merchant = { id, username: '_platform' };
      return handler(req, res, next);
    } catch (e) { next(e); }
  };
}

/* ─── Platform info — id, brand, api_key, device_auth_key, balance ─── */
async function getInfo(req, res, next) {
  try {
    const id = await getPlatformMerchantId();
    const r = await pool.query(
      `SELECT m.id, m.name, m.wallet_balance, m.currency, m.created_at,
              k.device_auth_key,
              b.id AS brand_id, b.api_key, b.domain AS brand_domain
         FROM merchants m
         JOIN merchant_keys k ON k.merchant_id = m.id
         LEFT JOIN brands b ON b.merchant_id = m.id AND b.is_default = TRUE
        WHERE m.id = $1`,
      [id]
    );
    const m = r.rows[0];

    // Count enabled gateways + bound devices for at-a-glance status.
    const counts = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM gateways WHERE merchant_id = $1 AND is_enabled = TRUE) AS active_gateway_count,
         (SELECT COUNT(*)::int FROM devices  WHERE merchant_id = $1 AND unbound_at IS NULL) AS bound_device_count`,
      [id]
    );
    res.json({ platform: { ...m, ...counts.rows[0] } });
  } catch (e) { next(e); }
}

/* ─── Recent recharges (sessions tagged wallet_topup) — admin queue ─── */
async function listRecharges(req, res, next) {
  try {
    const id = await getPlatformMerchantId();
    const status = ['pending', 'success', 'failed', 'expired', 'cancelled'].includes(req.query.status)
      ? req.query.status : null;
    const limit = Math.min(200, Number(req.query.limit) || 50);

    const params = [id];
    let sql = `
      SELECT s.id AS session_id, s.amount, s.currency, s.status AS session_status,
             s.created_at AS session_created_at, s.metadata,
             rm.id AS merchant_id, rm.name AS merchant_name, rm.username AS merchant_username,
             t.id AS transaction_id, t.txnid_submitted, t.status AS tx_status,
             t.result_source, t.verified_at, t.failure_reason,
             g.provider, g.variant, g.account_number, g.label AS gateway_label
        FROM payment_sessions s
        LEFT JOIN merchants rm ON rm.id::text = (s.metadata->>'recharge_for_merchant_id')
        LEFT JOIN LATERAL (
          SELECT id, txnid_submitted, status, result_source, verified_at, failure_reason, gateway_id
            FROM transactions
           WHERE session_id = s.id
           ORDER BY created_at DESC LIMIT 1
        ) t ON TRUE
        LEFT JOIN gateways g ON g.id = t.gateway_id
       WHERE s.merchant_id = $1
         AND s.metadata->>'type' = 'wallet_topup'
    `;
    if (status) { params.push(status); sql += ` AND s.status = $${params.length}`; }
    sql += ` ORDER BY s.created_at DESC LIMIT ${limit}`;

    const r = await pool.query(sql, params);
    res.json({ recharges: r.rows });
  } catch (e) { next(e); }
}

/* ─── Platform-wide pricing/settings ─── */

const SETTINGS_FIELDS = [
  'verify_charge_amount',
  'verify_charge_currency',
  'verify_charge_enabled',
  'low_balance_threshold',
  'verify_charge_type',
  'verify_charge_percent',
  'topup_fee_enabled',
  'topup_fee_percent',
  'key_unlock_fee',
  'vendor_activation_fee',
  'vendor_verify_charge_enabled',
  'vendor_verify_charge_type',
  'vendor_verify_charge_amount',
  'vendor_verify_charge_percent',
];

const SETTINGS_COLUMNS =
  `verify_charge_amount, verify_charge_currency, verify_charge_enabled,
   low_balance_threshold, verify_charge_type, verify_charge_percent,
   topup_fee_enabled, topup_fee_percent, key_unlock_fee,
   vendor_activation_fee, vendor_verify_charge_enabled, vendor_verify_charge_type,
   vendor_verify_charge_amount, vendor_verify_charge_percent, updated_at`;

async function getSettings(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT ${SETTINGS_COLUMNS} FROM platform_settings WHERE id = 1`
    );
    res.json({ settings: r.rows[0] || {
      verify_charge_amount: 0, verify_charge_currency: 'BDT',
      verify_charge_enabled: false, low_balance_threshold: 0,
      verify_charge_type: 'fixed', verify_charge_percent: 0,
      topup_fee_enabled: false, topup_fee_percent: 0, key_unlock_fee: 0,
      vendor_activation_fee: 0,
      vendor_verify_charge_enabled: false, vendor_verify_charge_type: 'percent',
      vendor_verify_charge_amount: 0, vendor_verify_charge_percent: 0,
    } });
  } catch (e) { next(e); }
}

async function updateSettings(req, res, next) {
  try {
    const patch = {};
    for (const f of SETTINGS_FIELDS) {
      if (req.body[f] === undefined) continue;
      patch[f] = req.body[f];
    }

    // Coerce types + validate
    if ('verify_charge_amount' in patch) {
      const n = Number(patch.verify_charge_amount);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'verify_charge_amount must be a non-negative number' });
      patch.verify_charge_amount = n;
    }
    if ('low_balance_threshold' in patch) {
      const n = Number(patch.low_balance_threshold);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'low_balance_threshold must be a non-negative number' });
      patch.low_balance_threshold = n;
    }
    if ('verify_charge_currency' in patch) {
      const c = String(patch.verify_charge_currency || '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) return res.status(400).json({ error: 'verify_charge_currency must be a 3-letter ISO code' });
      patch.verify_charge_currency = c;
    }
    if ('verify_charge_type' in patch) {
      const t = String(patch.verify_charge_type || '').trim().toLowerCase();
      if (t !== 'fixed' && t !== 'percent') return res.status(400).json({ error: "verify_charge_type must be 'fixed' or 'percent'" });
      patch.verify_charge_type = t;
    }
    if ('verify_charge_percent' in patch) {
      const n = Number(patch.verify_charge_percent);
      if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ error: 'verify_charge_percent must be between 0 and 100' });
      patch.verify_charge_percent = n;
    }
    if ('verify_charge_enabled' in patch) patch.verify_charge_enabled = !!patch.verify_charge_enabled;
    if ('topup_fee_enabled' in patch) patch.topup_fee_enabled = !!patch.topup_fee_enabled;
    if ('topup_fee_percent' in patch) {
      const n = Number(patch.topup_fee_percent);
      if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ error: 'topup_fee_percent must be between 0 and 100' });
      patch.topup_fee_percent = n;
    }
    if ('key_unlock_fee' in patch) {
      const n = Number(patch.key_unlock_fee);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'key_unlock_fee must be a non-negative number' });
      patch.key_unlock_fee = n;
    }
    if ('vendor_activation_fee' in patch) {
      const n = Number(patch.vendor_activation_fee);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'vendor_activation_fee must be a non-negative number' });
      patch.vendor_activation_fee = n;
    }
    if ('vendor_verify_charge_enabled' in patch) patch.vendor_verify_charge_enabled = !!patch.vendor_verify_charge_enabled;
    if ('vendor_verify_charge_type' in patch) {
      const t = String(patch.vendor_verify_charge_type || '').trim().toLowerCase();
      if (t !== 'fixed' && t !== 'percent') return res.status(400).json({ error: "vendor_verify_charge_type must be 'fixed' or 'percent'" });
      patch.vendor_verify_charge_type = t;
    }
    if ('vendor_verify_charge_amount' in patch) {
      const n = Number(patch.vendor_verify_charge_amount);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'vendor_verify_charge_amount must be a non-negative number' });
      patch.vendor_verify_charge_amount = n;
    }
    if ('vendor_verify_charge_percent' in patch) {
      const n = Number(patch.vendor_verify_charge_percent);
      if (!Number.isFinite(n) || n < 0 || n > 100) return res.status(400).json({ error: 'vendor_verify_charge_percent must be between 0 and 100' });
      patch.vendor_verify_charge_percent = n;
    }

    if (Object.keys(patch).length === 0) {
      return getSettings(req, res, next);
    }

    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(patch)) {
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    sets.push('updated_at = NOW()');

    const sql = `UPDATE platform_settings SET ${sets.join(', ')} WHERE id = 1
                 RETURNING ${SETTINGS_COLUMNS}`;
    const r = await pool.query(sql, params);
    // Bust the wallet service's settings cache so the change takes effect now.
    try { require('../services/wallet').invalidatePlatformSettingsCache(); } catch {}
    res.json({ settings: r.rows[0] });
  } catch (e) { next(e); }
}

/* ─── Platform revenue / earnings — super-admin income view ─── */
async function getRevenue(req, res, next) {
  try {
    const limit = Math.min(200, Number(req.query.limit) || 50);

    // Totals by source + grand total, plus simple time windows.
    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(amount), 0)                                                   AS total,
         COALESCE(SUM(amount) FILTER (WHERE type = 'verify_fee'), 0)                AS verify_fee_total,
         COALESCE(SUM(amount) FILTER (WHERE type = 'topup_fee'), 0)                 AS topup_fee_total,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)   AS today,
         COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS this_month,
         COUNT(*)::int                                                              AS entry_count
       FROM platform_revenue`
    );

    // Currency: revenue rows carry their own, but the platform's configured
    // verify-charge currency is the canonical display currency.
    const cur = await pool.query(
      `SELECT verify_charge_currency FROM platform_settings WHERE id = 1`
    );

    const recent = await pool.query(
      `SELECT r.id, r.type, r.amount, r.currency, r.note, r.created_at,
              m.name AS merchant_name, m.username AS merchant_username
         FROM platform_revenue r
         LEFT JOIN merchants m ON m.id = r.merchant_id
        ORDER BY r.created_at DESC
        LIMIT ${limit}`
    );

    const t = totals.rows[0];
    res.json({
      currency: cur.rows[0]?.verify_charge_currency || 'BDT',
      total:            Number(t.total),
      verify_fee_total: Number(t.verify_fee_total),
      topup_fee_total:  Number(t.topup_fee_total),
      today:            Number(t.today),
      this_month:       Number(t.this_month),
      entry_count:      t.entry_count,
      recent:           recent.rows,
    });
  } catch (e) { next(e); }
}

module.exports = {
  getPlatformMerchantId,
  asPlatformMerchant,
  getInfo,
  listRecharges,
  getSettings,
  updateSettings,
  getRevenue,
  // The proxied handlers (the same merchant-facing handlers, just with req.merchant injected)
  listGateways:    asPlatformMerchant(gatewayCtrl.list),
  createGateway:   asPlatformMerchant(gatewayCtrl.create),
  updateGateway:   asPlatformMerchant(gatewayCtrl.update),
  toggleGateway:   asPlatformMerchant(gatewayCtrl.toggle),
  removeGateway:   asPlatformMerchant(gatewayCtrl.remove),
  listDevices:     asPlatformMerchant(deviceCtrl.listForMerchant),
  listDeviceHistory: asPlatformMerchant(deviceCtrl.listHistoryForMerchant),
  removeDevice:    asPlatformMerchant(deviceCtrl.deleteForMerchant),
  listTransactions: asPlatformMerchant(paymentCtrl.listTransactions),
  manualResolveTransaction: asPlatformMerchant(paymentCtrl.manualResolve),
};
