const pool = require('../db/pool');

// Per-provider allowed variants. Add entries here as you support more providers/apps.
const CATALOG = {
  bkash:   ['personal', 'agent'],
  nagad:   ['personal', 'agent'],
  rocket:  ['personal', 'agent'],
  upi:     ['gpay', 'phonepe', 'paytm', 'other'],
};
const CHARGE_TYPES = ['fixed', 'percent'];

function validateBody(body) {
  const provider = String(body.provider || '').toLowerCase();
  const variant  = String(body.variant  || '').toLowerCase();
  const account_number = String(body.account_number || '').trim();

  if (!CATALOG[provider])                     return 'Invalid provider';
  if (!CATALOG[provider].includes(variant))   return `Invalid variant for ${provider}. Allowed: ${CATALOG[provider].join(', ')}`;
  if (!account_number)                        return 'Account number is required';

  if (body.charge_type && !CHARGE_TYPES.includes(body.charge_type))
    return 'Invalid charge_type';
  if (body.discount_type && !CHARGE_TYPES.includes(body.discount_type))
    return 'Invalid discount_type';

  return null;
}

function toNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function list(req, res, next) {
  try {
    const { rows } = await pool.query(
      `SELECT id, provider, variant, account_number, label,
              min_amount, max_amount, charge_value, charge_type,
              discount_value, discount_type, balance_check, is_enabled,
              created_at, updated_at
         FROM gateways
        WHERE merchant_id = $1
        ORDER BY created_at ASC`,
      [req.merchant.id]
    );
    res.json({ gateways: rows });
  } catch (e) { next(e); }
}

async function create(req, res, next) {
  try {
    const err = validateBody(req.body);
    if (err) return res.status(400).json({ error: err });

    const provider = String(req.body.provider).toLowerCase();
    const variant  = String(req.body.variant).toLowerCase();
    const account_number = String(req.body.account_number).trim();

    const r = await pool.query(
      `INSERT INTO gateways (
         merchant_id, provider, variant, account_number, label,
         min_amount, max_amount, charge_value, charge_type,
         discount_value, discount_type, balance_check
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        req.merchant.id, provider, variant, account_number,
        req.body.label || null,
        toNum(req.body.min_amount), toNum(req.body.max_amount),
        toNum(req.body.charge_value), req.body.charge_type || null,
        toNum(req.body.discount_value), req.body.discount_type || null,
        !!req.body.balance_check,
      ]
    );
    res.status(201).json({ gateway: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'A gateway with this account number already exists for this provider/variant.' });
    }
    next(e);
  }
}

async function update(req, res, next) {
  try {
    // Don't allow changing provider/variant on update (they identify the gateway).
    // account_number may change.
    const account_number = req.body.account_number ? String(req.body.account_number).trim() : null;

    const r = await pool.query(
      `UPDATE gateways SET
         account_number = COALESCE($3, account_number),
         label          = $4,
         min_amount     = $5,
         max_amount     = $6,
         charge_value   = $7,
         charge_type    = $8,
         discount_value = $9,
         discount_type  = $10,
         balance_check  = COALESCE($11, balance_check),
         updated_at     = NOW()
       WHERE id = $1 AND merchant_id = $2
       RETURNING *`,
      [
        req.params.id, req.merchant.id,
        account_number,
        req.body.label || null,
        toNum(req.body.min_amount), toNum(req.body.max_amount),
        toNum(req.body.charge_value), req.body.charge_type || null,
        toNum(req.body.discount_value), req.body.discount_type || null,
        typeof req.body.balance_check === 'boolean' ? req.body.balance_check : null,
      ]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Gateway not found' });
    res.json({ gateway: r.rows[0] });
  } catch (e) { next(e); }
}

async function toggle(req, res, next) {
  try {
    const r = await pool.query(
      `UPDATE gateways SET is_enabled = NOT is_enabled, updated_at = NOW()
        WHERE id = $1 AND merchant_id = $2
        RETURNING id, is_enabled`,
      [req.params.id, req.merchant.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Gateway not found' });
    res.json({ id: r.rows[0].id, is_enabled: r.rows[0].is_enabled });
  } catch (e) { next(e); }
}

async function remove(req, res, next) {
  try {
    const r = await pool.query(
      `DELETE FROM gateways WHERE id = $1 AND merchant_id = $2 RETURNING id`,
      [req.params.id, req.merchant.id]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Gateway not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
}

module.exports = { list, create, update, toggle, remove };
