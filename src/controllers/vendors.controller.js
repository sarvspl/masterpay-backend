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
const { availabilityFor } = require('../services/availability');
const { createVendor, serialize, suspensionOf, suspendVendor, unsuspendVendor } = require('../services/vendors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Accepts `a,b,c` or repeated ?k=a&k=b. Trims, drops blanks, caps the list.
function parseList(value, max = 200) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const v of raw) {
    const s = String(v).trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/* ─── POST /api/vendors ───
 * Body: { label?, external_id? }
 * Creates a vendor under the calling merchant and returns its device_auth_key.
 * Idempotent on external_id: a repeat create with the same external_id returns
 * the existing vendor (200) instead of minting a duplicate.
 */
async function create(req, res, next) {
  try {
    const { vendor, existed } = await createVendor(req.brand.merchant_id, {
      label: req.body.label,
      externalId: req.body.external_id,
    });
    // Idempotent on external_id: 200 + existed:true when we returned an
    // existing vendor, 201 when we minted a new one.
    if (existed) return res.status(200).json({ vendor, existed: true });
    res.status(201).json({ vendor });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
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
      `SELECT id, label, device_auth_key, external_id, is_default, created_at,
              suspended_at, suspended_by, suspended_reason
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
      vendor: {
        ...serialize(a.rows[0]),
        ...suspensionOf(a.rows[0]),
        gateways: g.rows,
        bound_devices: d.rows[0].n,
      },
    });
  } catch (e) { next(e); }
}

/* ─── GET /api/vendors/availability ───
 * Query: ?vendor_ids=a,b  ?external_ids=seller_07,seller_88  ?amount=1200
 *
 * Answers "which of these sellers can take an online payment right now?" so the
 * marketplace can decide whether to render a Pay button BEFORE the customer
 * clicks it. Omit both id params to get every vendor under this merchant.
 *
 * `amount` is optional but recommended: a vendor whose only number has a
 * min/max that excludes the cart total genuinely can't take that order, and
 * without the amount we'd wrongly report them as payable.
 *
 * Each entry carries `payable`, plus (when false) a stable `reason` code and a
 * ready-to-render bilingual `display` block.
 */
async function availability(req, res, next) {
  try {
    const ids = parseList(req.query.vendor_ids);
    const externalIds = parseList(req.query.external_ids);

    const badId = ids.find((id) => !UUID_RE.test(id));
    if (badId) return res.status(400).json({ error: `vendor_ids contains an invalid id: ${badId}` });

    let amount = null;
    if (req.query.amount != null && String(req.query.amount).trim() !== '') {
      amount = Number(req.query.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }
    }

    // Same resolution order as session creation (explicit > merchant default),
    // so what this endpoint reports matches what the checkout will actually
    // offer. A payment rail receives one currency only, so a vendor holding
    // nothing that can take this one is genuinely unavailable for it.
    const m = await pool.query('SELECT currency FROM merchants WHERE id = $1', [req.brand.merchant_id]);
    const currency = (req.query.currency ? String(req.query.currency).toUpperCase() : null)
                  || (m.rows[0] && m.rows[0].currency)
                  || 'BDT';

    const vendors = await availabilityFor(req.brand.merchant_id, { ids, externalIds, amount, currency });

    res.json({
      currency,
      amount,
      vendors,
    });
  } catch (e) { next(e); }
}

/* ─── POST /api/vendors/:id/suspend   (X-API-Key) ───
 * Body: { reason? }
 * The marketplace suspends its own seller. A suspended vendor can't take
 * payments (availability reports it, session creation is refused, and their
 * bound phone stops verifying). Recorded as a 'merchant' suspension, so the
 * merchant — or a superadmin — can later lift it.
 */
async function suspend(req, res, next) {
  try {
    const r = await suspendVendor(req.params.id, req.brand.merchant_id, {
      by: 'merchant',
      reason: req.body && req.body.reason,
    });
    if (r.notFound) return res.status(404).json({ error: 'Vendor not found' });
    res.json({
      ok: true,
      vendor_id: req.params.id,
      already_suspended: !!r.alreadySuspended,
      ...suspensionOf(r.account),
    });
  } catch (e) { next(e); }
}

/* ─── POST /api/vendors/:id/unsuspend   (X-API-Key) ───
 * Lift a suspension the MERCHANT applied. A suspension a superadmin applied
 * cannot be lifted here — it returns 403; only a superadmin can revoke it.
 */
async function unsuspend(req, res, next) {
  try {
    const r = await unsuspendVendor(req.params.id, req.brand.merchant_id, { by: 'merchant' });
    if (r.notFound)     return res.status(404).json({ error: 'Vendor not found' });
    if (r.forbidden)    return res.status(403).json({
      error: 'This vendor was suspended by MASTER PAY and can only be reinstated by MASTER PAY support.',
      code: 'suspended_by_platform',
    });
    if (r.notSuspended) return res.json({ ok: true, vendor_id: req.params.id, suspended: false, was_suspended: false });
    res.json({ ok: true, vendor_id: req.params.id, suspended: false });
  } catch (e) { next(e); }
}

module.exports = { create, list, get, availability, suspend, unsuspend };
