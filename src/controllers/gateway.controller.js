const pool = require('../db/pool');
const { extractTxnId, extractAmount, findGatewayInSms, extractPayer, extractDirection } = require('./sms.controller');
const { getPlatformSettings } = require('../services/wallet');
const { isUpiProvider, extractVpa, senderHintsForBank, listBanks } = require('../utils/upi');

// An account may add gateways once its device key is unlocked — or always, if
// the key-unlock gate is disabled platform-wide (fee 0).
async function accountCanAddGateways(account) {
  if (account.keys_unlocked) return true;
  const settings = await getPlatformSettings().catch(() => ({ key_unlock_fee: 0 }));
  return Number(settings.key_unlock_fee || 0) <= 0;
}

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

/**
 * Extra rules for UPI gateways (gpay/phonepe).
 *
 * The account_number check is the important one. GPay and PhonePe never send an
 * SMS — the vendor's BANK does, and that SMS quotes the bank account tail
 * ("A/c XX4328 credited...") and never the VPA. A vendor who pastes their UPI
 * ID into account_number gets a gateway that silently never matches a payment.
 * Rejecting it here converts a silent production failure into a form error.
 */
function validateUpiBody(body) {
  const vpa = extractVpa(body.vpa);
  if (!vpa) return 'A valid UPI ID is required (e.g. yourname@okaxis). You can also upload your UPI QR and we will read the ID from it.';

  const account_number = String(body.account_number || '').trim();
  const digits = account_number.replace(/\D/g, '');
  if (digits.length < 4) {
    return 'For UPI, Account number must be your BANK ACCOUNT number (or its last 4 digits, e.g. 4328) — not your UPI ID. Your bank quotes this in the payment SMS we read to confirm payments.';
  }
  if (account_number.includes('@')) {
    return 'Account number looks like a UPI ID. Put the UPI ID in the UPI ID field and your bank account number (or last 4 digits) here.';
  }

  if (body.bank_code) {
    const code = String(body.bank_code).toLowerCase();
    if (senderHintsForBank(code).length === 0) {
      return `Unknown bank code "${body.bank_code}". Allowed: ${listBanks().map((b) => b.code).join(', ')}`;
    }
  }
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
    // Optional ?account_id= filter; otherwise all of the merchant's gateways
    // (each row carries account_id so the dashboard can group by account).
    const accountId = req.query.account_id ? String(req.query.account_id) : null;
    const params = [req.merchant.id];
    let where = 'merchant_id = $1';
    if (accountId) { params.push(accountId); where += ` AND account_id = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT id, account_id, provider, variant, account_number, label,
              min_amount, max_amount, charge_value, charge_type,
              discount_value, discount_type, balance_check, is_enabled,
              vpa, bank_code, created_at, updated_at
         FROM gateways
        WHERE ${where}
        ORDER BY created_at ASC`,
      params
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

    const upi = isUpiProvider(provider);
    if (upi) {
      const upiErr = validateUpiBody(req.body);
      if (upiErr) return res.status(400).json({ error: upiErr });
    }

    // Gateways belong to a specific account. When account_id is omitted (e.g.
    // the platform-merchant admin console, which has a single account), fall
    // back to the merchant's Primary account.
    let account_id = String(req.body.account_id || '').trim();
    const acc = account_id
      ? await pool.query('SELECT id, keys_unlocked FROM accounts WHERE id = $1 AND merchant_id = $2', [account_id, req.merchant.id])
      : await pool.query('SELECT id, keys_unlocked FROM accounts WHERE merchant_id = $1 AND is_default = TRUE', [req.merchant.id]);
    if (acc.rowCount === 0) return res.status(404).json({ error: 'Account not found' });
    account_id = acc.rows[0].id;
    if (!(await accountCanAddGateways(acc.rows[0]))) {
      return res.status(403).json({ error: 'Unlock this account before adding gateways.', code: 'account_locked' });
    }

    const account_number = String(req.body.account_number).trim();

    const r = await pool.query(
      `INSERT INTO gateways (
         merchant_id, account_id, provider, variant, account_number, label,
         min_amount, max_amount, charge_value, charge_type,
         discount_value, discount_type, balance_check, vpa, bank_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        req.merchant.id, account_id, provider, variant, account_number,
        req.body.label || null,
        toNum(req.body.min_amount), toNum(req.body.max_amount),
        toNum(req.body.charge_value), req.body.charge_type || null,
        toNum(req.body.discount_value), req.body.discount_type || null,
        !!req.body.balance_check,
        upi ? extractVpa(req.body.vpa) : null,
        upi && req.body.bank_code ? String(req.body.bank_code).toLowerCase() : null,
      ]
    );
    const gateway = r.rows[0];
    // Inbound auto-creation was removed — SMS upload is staging-only now.
    res.status(201).json({ gateway, retroactively_matched: 0 });
  } catch (e) {
    if (e.code === '23505') {
      // The (account_id, provider, variant) unique index — one of each pair per account.
      return res.status(409).json({ error: 'This account already has a gateway for this provider and type. Each account allows one per provider+variant.' });
    }
    next(e);
  }
}

async function update(req, res, next) {
  try {
    // Don't allow changing provider/variant on update (they identify the gateway).
    // account_number may change.
    const account_number = req.body.account_number ? String(req.body.account_number).trim() : null;

    // provider is immutable here, so read it off the existing row to decide
    // whether the UPI rules apply.
    const existing = await pool.query(
      `SELECT provider, vpa, bank_code, account_number FROM gateways WHERE id = $1 AND merchant_id = $2`,
      [req.params.id, req.merchant.id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Gateway not found' });

    const upi = isUpiProvider(existing.rows[0].provider);
    if (upi) {
      // Validate against the merged result, so a partial edit (e.g. label only)
      // isn't rejected for omitting fields that are already stored and valid.
      const upiErr = validateUpiBody({
        vpa: req.body.vpa != null ? req.body.vpa : existing.rows[0].vpa,
        bank_code: req.body.bank_code != null ? req.body.bank_code : existing.rows[0].bank_code,
        account_number: account_number || existing.rows[0].account_number,
      });
      if (upiErr) return res.status(400).json({ error: upiErr });
    }

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
         vpa            = COALESCE($12, vpa),
         bank_code      = COALESCE($13, bank_code),
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
        upi && req.body.vpa != null ? extractVpa(req.body.vpa) : null,
        upi && req.body.bank_code != null ? String(req.body.bank_code).toLowerCase() : null,
      ]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Gateway not found' });
    res.json({ gateway: r.rows[0], retroactively_matched: 0 });
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
  } catch (e) {
    // transactions.gateway_id is ON DELETE RESTRICT: a number that has ever
    // taken a payment can't be deleted without destroying that payment's
    // history. Pausing it (is_enabled = FALSE) removes it from checkout and is
    // what the user actually wants.
    //
    // An explicit RESTRICT raises 23001 (restrict_violation), NOT the 23503
    // (foreign_key_violation) you'd expect — both are caught so this keeps
    // working if the constraint is ever changed to NO ACTION.
    if (e && (e.code === '23001' || e.code === '23503')) {
      return res.status(409).json({
        error: 'This payment number has payments recorded against it, so it can’t be deleted. Pause it instead — it will stop appearing at checkout.',
        code: 'gateway_in_use',
      });
    }
    next(e);
  }
}

/**
 * Write access to this controller is reached only through:
 *   - the vendor panel      (/api/vendor/gateways, account_id forced from the token)
 *   - the super-admin console (/api/admin/platform/gateways, the platform's own numbers)
 *
 * The merchant dashboard and the marketplace vendors API are read-only: a
 * marketplace owns no payment numbers, and a vendor's numbers belong to the
 * vendor. Those routers 403 every write before it reaches here. (The older
 * guardCreateNotVendor / guardGatewayNotVendor middlewares were deleted with the
 * merchant Gateways page — a merchant can no longer write a gateway at all, so
 * there is nothing left for them to guard.)
 */
module.exports = { list, create, update, toggle, remove };
