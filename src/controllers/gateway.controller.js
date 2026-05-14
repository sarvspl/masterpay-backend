const pool = require('../db/pool');
const { extractTxnId, extractAmount, findGatewayInSms, extractPayer, extractDirection } = require('./sms.controller');

const CHARGE_TYPES = ['fixed', 'percent'];

// Validate provider+variant against the DB catalog.
// Returns an error message string, or null on success.
async function validateProviderVariant(provider, variant) {
  if (!provider) return 'Invalid provider';
  const r = await pool.query(
    `SELECT variants FROM providers WHERE id = $1 AND is_enabled = TRUE`,
    [provider]
  );
  if (r.rowCount === 0) return `Provider "${provider}" not found or disabled`;
  const variants = r.rows[0].variants || [];
  if (!variants.includes(variant)) {
    return `Invalid variant for ${provider}. Allowed: ${variants.join(', ')}`;
  }
  return null;
}

function validateBody(body) {
  const account_number = String(body.account_number || '').trim();
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

/**
 * Scan unmatched SMS in the last 7 days for this merchant. For each SMS whose
 * body references the newly-added gateway's account (and has parseable TxnID +
 * amount), create an inbound transaction. Safe to call after creating any gateway.
 *
 * Returns the count of SMS that produced new transactions.
 */
async function rescanUnmatchedSms(merchantId, gateway) {
  const sms = await pool.query(
    `SELECT id, body
       FROM sms_messages
      WHERE merchant_id = $1
        AND matched_tx_id IS NULL
        AND received_at > NOW() - INTERVAL '7 days'
      ORDER BY received_at DESC`,
    [merchantId]
  );
  if (sms.rows.length === 0) return 0;

  const gws = [gateway]; // only check against THIS gateway (we just created it)
  let count = 0;

  for (const s of sms.rows) {
    // Skip debit (outgoing) SMS — never a customer payment
    if (extractDirection(s.body) === 'debit') continue;

    const hit = findGatewayInSms(s.body, gws);
    if (!hit) continue;
    const txnid = extractTxnId(s.body);
    const amount = extractAmount(s.body);
    if (!txnid || amount == null) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Skip if this TxnID has already been recorded
      const dup = await client.query(
        `SELECT 1 FROM transactions WHERE merchant_id = $1 AND txnid_submitted = $2`,
        [merchantId, txnid]
      );
      if (dup.rowCount > 0) {
        await client.query('ROLLBACK');
        continue;
      }
      const payer = extractPayer(s.body);
      const ins = await client.query(
        `INSERT INTO transactions
           (merchant_id, gateway_id, txnid_submitted, amount, status,
            result_source, matched_sms, verified_at, payer_name, payer_phone)
         VALUES ($1, $2, $3, $4, 'success', 'sms_inbound', $5, NOW(), $6, $7)
         RETURNING id`,
        [merchantId, gateway.id, txnid, amount, s.body, payer.name, payer.phone]
      );
      await client.query(
        `UPDATE sms_messages SET matched_tx_id = $1 WHERE id = $2`,
        [ins.rows[0].id, s.id]
      );
      await client.query('COMMIT');
      count += 1;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch {}
      if (e.code !== '23505') throw e; // ignore dup-on-race
    } finally {
      client.release();
    }
  }
  return count;
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

    const provider = String(req.body.provider || '').toLowerCase();
    const variant  = String(req.body.variant || '').toLowerCase();
    const providerErr = await validateProviderVariant(provider, variant);
    if (providerErr) return res.status(400).json({ error: providerErr });

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
    const gateway = r.rows[0];

    // Retroactively scan recent unmatched SMS for this merchant — any that have
    // a TxnID + amount AND reference this gateway's account get auto-promoted
    // to inbound transactions. Cap at last 7 days to keep it bounded.
    const matched = await rescanUnmatchedSms(req.merchant.id, gateway);

    res.status(201).json({ gateway, retroactively_matched: matched });
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

    // If account_number changed, retry unmatched SMS against the updated gateway.
    let matched = 0;
    if (account_number) {
      matched = await rescanUnmatchedSms(req.merchant.id, r.rows[0]);
    }

    res.json({ gateway: r.rows[0], retroactively_matched: matched });
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
