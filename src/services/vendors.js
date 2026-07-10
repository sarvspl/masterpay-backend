/**
 * Vendor provisioning — the one place a vendor row is created.
 *
 * Two callers, identical result:
 *   - POST /api/vendors          (marketplace server, X-API-Key)
 *   - POST /api/merchant/accounts (marketplace operator, from the dashboard)
 *
 * They must produce the same thing, or a vendor onboarded by hand would behave
 * differently from one onboarded by the marketplace's signup code.
 *
 * A vendor is born:
 *   - keys_unlocked = TRUE  → the device key is usable immediately; vendors are
 *                             free to provision (the paid gate is the vendor's
 *                             own activation fee, which they pay in their panel)
 *   - is_default    = FALSE → it is never the merchant's own Primary account
 *   - username      = NULL  → nobody has claimed the panel login yet, so the
 *                             vendor reports `not_registered` until the seller
 *                             registers with the device key below
 */
const pool = require('./../db/pool');
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

const RETURNING = 'id, label, device_auth_key, external_id, is_default, created_at';

async function findByExternalId(merchantId, externalId) {
  const r = await pool.query(
    `SELECT ${RETURNING} FROM accounts WHERE merchant_id = $1 AND external_id = $2`,
    [merchantId, externalId]
  );
  return r.rowCount > 0 ? r.rows[0] : null;
}

/**
 * Create a vendor under `merchantId`.
 *
 * Idempotent on `external_id`: calling twice with the same one returns the
 * existing vendor rather than minting a duplicate, so a marketplace can call
 * this on every seller signup without guarding.
 *
 * Returns { vendor, existed }. Throws { status, message } on bad input.
 */
async function createVendor(merchantId, { label, externalId } = {}) {
  const cleanLabel = String(label || '').trim();
  const cleanExt = externalId != null && String(externalId).trim() !== ''
    ? String(externalId).trim()
    : null;

  if (cleanLabel.length > 120) {
    throw Object.assign(new Error('label must be at most 120 characters'), { status: 400 });
  }
  if (cleanExt && cleanExt.length > 120) {
    throw Object.assign(new Error('external_id must be at most 120 characters'), { status: 400 });
  }

  if (cleanExt) {
    const existing = await findByExternalId(merchantId, cleanExt);
    if (existing) return { vendor: serialize(existing), existed: true };
  }

  const count = await pool.query(
    'SELECT COUNT(*)::int AS n FROM accounts WHERE merchant_id = $1',
    [merchantId]
  );
  const finalLabel = cleanLabel || `Vendor ${count.rows[0].n + 1}`;

  // Retry on the rare device_auth_key UNIQUE collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await pool.query(
        `INSERT INTO accounts (merchant_id, label, device_auth_key, keys_unlocked, is_default, external_id)
         VALUES ($1, $2, $3, TRUE, FALSE, $4)
         RETURNING ${RETURNING}`,
        [merchantId, finalLabel, generateDeviceAuthKey(), cleanExt]
      );
      return { vendor: serialize(r.rows[0]), existed: false };
    } catch (e) {
      if (e.code !== '23505') throw e;
      // Lost a race on external_id → return the winner. Otherwise it's a
      // device_auth_key collision → retry with a fresh key.
      if (cleanExt) {
        const again = await findByExternalId(merchantId, cleanExt);
        if (again) return { vendor: serialize(again), existed: true };
      }
      if (attempt === 4) throw e;
    }
  }
}

/**
 * Is this account a vendor (as opposed to the merchant's own Primary)?
 * A vendor was provisioned as one (external_id) or has claimed a panel login
 * (username). Used to refuse operator actions on a seller's account.
 */
async function isVendorAccount(accountId) {
  if (!accountId) return false;
  const r = await pool.query(
    'SELECT is_default, external_id, username FROM accounts WHERE id = $1',
    [accountId]
  );
  if (r.rowCount === 0) return false;
  const a = r.rows[0];
  return !a.is_default && (a.external_id != null || a.username != null);
}

module.exports = { createVendor, isVendorAccount, serialize };
