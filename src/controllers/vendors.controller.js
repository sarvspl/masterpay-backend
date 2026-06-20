/**
 * Vendors — marketplace-facing API (authenticated by the merchant API key, the
 * same X-API-Key used to create payment sessions).
 *
 * A "vendor" is a row in the `accounts` table: a receiving unit under one
 * merchant with its own device_auth_key, devices, and gateways. A marketplace
 * (e.g. abc.com) creates one vendor per seller so that a payment for Vendor A
 * is shown on Vendor A's gateways and only notifies Vendor A's phone(s).
 *
 * Vendors created here are FREE and their device key is usable immediately
 * (keys_unlocked = TRUE) — the paid extra-account-unlock flow in the dashboard
 * (accounts.controller.js) is a separate, merchant-initiated path.
 *
 * req.brand is attached by requireApiKey (middleware/apiKey.js).
 */
const pool = require('../db/pool');
const { generateDeviceAuthKey } = require('../utils/keys');

function serialize(v) {
  return {
    vendor_id:       v.id,
    label:           v.label,
    external_id:     v.external_id || null,
    device_auth_key: v.device_auth_key,
    is_default:      v.is_default,
    created_at:      v.created_at,
  };
}

/* ─── POST /api/vendors ───
 * Body: { label?, external_id? }
 * Creates a vendor under the calling merchant and returns its device_auth_key.
 * Idempotent on external_id: a repeat create with the same external_id returns
 * the existing vendor (200) instead of minting a duplicate.
 */
async function create(req, res, next) {
  try {
    const merchantId = req.brand.merchant_id;
    const label = String(req.body.label || '').trim();
    const externalId = req.body.external_id != null && String(req.body.external_id).trim() !== ''
      ? String(req.body.external_id).trim()
      : null;

    if (label.length > 120)      return res.status(400).json({ error: 'label must be at most 120 characters' });
    if (externalId && externalId.length > 120) return res.status(400).json({ error: 'external_id must be at most 120 characters' });

    // Idempotency: return the existing vendor if this external_id is already mapped.
    if (externalId) {
      const existing = await pool.query(
        `SELECT id, label, device_auth_key, external_id, is_default, created_at
           FROM accounts WHERE merchant_id = $1 AND external_id = $2`,
        [merchantId, externalId]
      );
      if (existing.rowCount > 0) {
        return res.status(200).json({ vendor: serialize(existing.rows[0]), existed: true });
      }
    }

    const count = await pool.query(
      'SELECT COUNT(*)::int AS n FROM accounts WHERE merchant_id = $1',
      [merchantId]
    );
    const finalLabel = label || `Vendor ${count.rows[0].n + 1}`;

    // Generate a unique device key (retry on the rare UNIQUE collision).
    let row;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await pool.query(
          `INSERT INTO accounts (merchant_id, label, device_auth_key, keys_unlocked, is_default, external_id)
           VALUES ($1, $2, $3, TRUE, FALSE, $4)
           RETURNING id, label, device_auth_key, external_id, is_default, created_at`,
          [merchantId, finalLabel, generateDeviceAuthKey(), externalId]
        );
        row = r.rows[0];
        break;
      } catch (e) {
        if (e.code === '23505') {
          // Lost a race on external_id → return the winner. Otherwise it's a
          // device_auth_key collision → retry with a fresh key.
          if (externalId) {
            const again = await pool.query(
              `SELECT id, label, device_auth_key, external_id, is_default, created_at
                 FROM accounts WHERE merchant_id = $1 AND external_id = $2`,
              [merchantId, externalId]
            );
            if (again.rowCount > 0) {
              return res.status(200).json({ vendor: serialize(again.rows[0]), existed: true });
            }
          }
          if (attempt < 4) continue;
        }
        throw e;
      }
    }

    res.status(201).json({ vendor: serialize(row) });
  } catch (e) { next(e); }
}

/* ─── GET /api/vendors ───
 * List the calling merchant's vendors (the Primary account is_default first).
 */
async function list(req, res, next) {
  try {
    const r = await pool.query(
      `SELECT id, label, device_auth_key, external_id, is_default, created_at
         FROM accounts WHERE merchant_id = $1
        ORDER BY is_default DESC, created_at ASC`,
      [req.brand.merchant_id]
    );
    res.json({ vendors: r.rows.map(serialize) });
  } catch (e) { next(e); }
}

/* ─── GET /api/vendors/:id ───
 * One vendor with its gateways and a live bound-device count.
 */
async function get(req, res, next) {
  try {
    const a = await pool.query(
      `SELECT id, label, device_auth_key, external_id, is_default, created_at
         FROM accounts WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, req.brand.merchant_id]
    );
    if (a.rowCount === 0) return res.status(404).json({ error: 'Vendor not found' });

    const g = await pool.query(
      `SELECT id, provider, variant, account_number, label, is_enabled, created_at
         FROM gateways WHERE account_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    const d = await pool.query(
      `SELECT COUNT(*)::int AS n FROM devices WHERE account_id = $1 AND unbound_at IS NULL`,
      [req.params.id]
    );

    res.json({
      vendor: { ...serialize(a.rows[0]), gateways: g.rows, bound_devices: d.rows[0].n },
    });
  } catch (e) { next(e); }
}

module.exports = { create, list, get };
